import {createInterface} from 'node:readline/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,normalize} from 'node:path';
import {ProfileError} from './profile-error.js';
export type Prompt=(question:string)=>Promise<string>;
export function requireInteractiveTerminal(message:string):void {
  if(!process.stdin.isTTY||!process.stderr.isTTY)throw new ProfileError('TERMINAL_REQUIRED',message);
}
export function requireSetupTerminal():void {
  requireInteractiveTerminal('Marketplace setup requires an interactive local terminal.');
}
export async function confirmWithApprove(preview:string):Promise<boolean> {
  process.stderr.write(preview.endsWith('\n')?preview:`${preview}\n`);
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  try{return (await terminal.question('Type APPROVE to confirm: ')).trim()==='APPROVE';}
  finally{terminal.close();}
}
export async function terminalPrompt(question:string):Promise<string> {
  requireSetupTerminal();
  const paused=process.stdin.isPaused(),terminal=createInterface({input:process.stdin,output:process.stderr});
  const controller=new AbortController();const cancel=()=>controller.abort();
  terminal.once('SIGINT',cancel);terminal.once('close',cancel);process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{return (await terminal.question(question,{signal:controller.signal})).trim();}
  catch(error){if(controller.signal.aborted)throw new ProfileError('CANCELLED','Marketplace setup was cancelled.');throw error;}
  finally{terminal.removeListener('SIGINT',cancel);terminal.removeListener('close',cancel);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);terminal.close();if(paused)process.stdin.pause();}
}
export function absoluteDirectory(input:string):string {
  const expanded=input==='~'?homedir():input.startsWith('~/')?join(homedir(),input.slice(2)):input;
  if(!isAbsolute(expanded)||/[\0\r\n]/.test(expanded)||expanded.length>4096)throw new ProfileError('SETUP_USAGE','Choose an absolute private directory path.');
  return normalize(expanded);
}
export async function yesNo(prompt:Prompt,question:string,defaultYes:boolean):Promise<boolean> {
  for(;;){
    const value=(await prompt(`${question} ${defaultYes?'[Y/n]':'[y/N]'}: `)).toLowerCase();
    if(!value)return defaultYes;if(value==='y'||value==='yes')return true;if(value==='n'||value==='no')return false;
    process.stderr.write('Answer yes or no.\n');
  }
}
export async function requiredText(prompt:Prompt,label:string,fallback?:string):Promise<string> {
  const value=await prompt(`${label}${fallback?` [${fallback}]`:''}: `)||fallback;
  if(!value||/[\0\r\n]/.test(value))throw new ProfileError('SETUP_USAGE',`${label} is required.`);return value;
}

export async function menuChoice(prompt:Prompt,question:string,choices:readonly string[],fallback:string):Promise<string> {
  for(;;){
    const value=await prompt(question)||fallback;
    if(choices.includes(value))return value;
    process.stderr.write(`Choose ${choices.join(', ')}.\n`);
  }
}
