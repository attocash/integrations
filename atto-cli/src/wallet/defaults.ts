import { AttoAddress, AttoAlgorithm, AttoPublicKey } from '@attocash/commons-core';
import type { WalletSettings } from './types.js';

// Same LIVE representative pool as the desktop wallet. Choose once per installation.
export const representativePublicKeys = [
  'd50d27281df93e71e6e7a279fc308d5e90891c27a1129cd0bf24bf94731f547f',
  'ebc906cc473fce6a5bc1e58622d6d807cb4bc820ac13169d88f96ee26d29b982',
  'e7877ac47b475989f3c24783e2d5c0ffc4943d1d0c48c02ba152305b0d42ff5b',
  'e00ba25f78dcd0f229a9335060256cef12609d161daf2fd614dc32c37ccdc56a',
  'a73f0b55a50d3bb89eead7b47005fd488cc2f540f342f893b72dd357200b4432',
  '5df80120502f2eac7cbf1af12555b5a82990a66745ff89573d6093f535ac25e8',
  '6c9a4b64bbb6ed51a305d1185d83288a62378dbE761e932e38c05c17623d74b1',
  '1d7948c4d449ac8151d7855f44276308e98c899c6f066eb9324dffaa15901929',
  '853380ff0f905b3801f3a32fa193250395b4bd0ca6d83e76eea7389ec9d4ba10',
  '58d293037fdfe6318ac97215e3e8a202cb27637a17831cbfb1964a4534343c48',
  '45eb652403ca618c5f1cff92b2bb1f4c7d86b903e880721937f07ea9e0e5648f',
  '096523285e1fe5755daabb94ecab124d0e395e1d2e613e97d10aa2717b82a4ce',
];

export function defaultSettings(): WalletSettings {
  return {
    network: 'LIVE',
    nodeUrl: 'https://gatekeeper.live.application.atto.cash',
    workerUrl: 'https://gatekeeper.live.application.atto.cash',
    representative: new AttoAddress(AttoAlgorithm.V1, AttoPublicKey.Companion.parse(representativePublicKeys[Math.floor(Math.random() * representativePublicKeys.length)]!)).value,
    autoReceive: true,
    minReceiveRaw: '1',
  };
}
