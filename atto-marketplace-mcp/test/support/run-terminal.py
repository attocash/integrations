#!/usr/bin/env python3
"""Run one explicitly scripted local-wallet CLI action behind a disposable PTY."""

import base64
import errno
import json
import os
import pty
import select
import signal
import sys
import termios
import time


def main():
    request = json.loads(sys.argv[1])
    command = request["command"]
    prompt = request.get("prompt")
    steps = request.get("steps", [{"prompt": prompt, "response": request.get("response")}] if prompt else [])
    timeout_seconds = request.get("timeoutSeconds", 90)
    child, master = pty.fork()
    if child == 0:
        environment = os.environ.copy()
        environment.update(request.get("environment", {}))
        os.execvpe(command[0], command, environment)

    captured = bytearray()
    response_sent = False
    step_index = 0
    search_offset = 0
    deadline = time.monotonic() + timeout_seconds
    status = None
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        _, status = os.waitpid(child, 0)
                        break
                    raise
                if not chunk:
                    break
                captured.extend(chunk)
                if len(captured) > 1_048_576:
                    raise RuntimeError("Terminal command exceeded the bounded output size.")
                while step_index < len(steps):
                    step = steps[step_index]
                    prompt_bytes = step["prompt"].encode("utf-8")
                    match = captured.find(prompt_bytes, search_offset)
                    if match < 0:
                        break
                    if step.get("hidden", False):
                        hidden_deadline = min(deadline, time.monotonic() + 2)
                        while termios.tcgetattr(master)[3] & termios.ECHO:
                            if time.monotonic() >= hidden_deadline:
                                raise RuntimeError("Hidden terminal input did not disable echo.")
                            time.sleep(0.005)
                    os.write(master, (step["response"] + "\n").encode("utf-8"))
                    search_offset = match + len(prompt_bytes)
                    step_index += 1
                    response_sent = True
            waited, child_status = os.waitpid(child, os.WNOHANG)
            if waited:
                status = child_status
                break

        if status is None:
            os.kill(child, signal.SIGKILL)
            _, status = os.waitpid(child, 0)
            timed_out = True
        else:
            timed_out = False

        # Drain a final line without forwarding it to the test runner. It may
        # include wallet recovery material printed by `atto wallet create`.
        while True:
            ready, _, _ = select.select([master], [], [], 0.05)
            if not ready:
                break
            try:
                chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            captured.extend(chunk)
            if len(captured) > 1_048_576:
                raise RuntimeError("Terminal command exceeded the bounded output size.")
    finally:
        os.close(master)

    result = {
        "exitCode": os.waitstatus_to_exitcode(status),
        "timedOut": timed_out,
        "promptAnswered": response_sent,
        "stepsAnswered": step_index,
        "transcriptBase64": base64.b64encode(captured).decode("ascii"),
    }
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
