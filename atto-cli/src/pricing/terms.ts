/** Informational acknowledgement, adapted from the desktop wallet's market-data notice. */
export const marketTerms = {
  version: '2026-09-05',
  title: 'USD conversion and wallet responsibility',
  text: 'USD conversions use an indicative daily Atto market-data price, not an executable market quote. '
    + 'Prices may be incorrect, delayed, unavailable, or outdated, and the displayed source and price date should be checked. '
    + 'Conversions round down to whole RAW and transactions send ATTO, not USD. No USD proceeds, exchange rate, or realizable value are promised. '
    + 'This information is not financial, investment, trading, legal, or tax advice and should not be your only basis for a decision. '
    + 'This wallet uses self-custody: you are responsible for securing your device and recovery phrase and checking destination addresses and amounts. '
    + 'Anyone with the recovery phrase may control your funds; confirmed network transactions may be irreversible. '
    + 'Acknowledgement records that you have read this information.',
} as const;
