// SPEC §6 estate letter and helper appendix (DECISIONS A25). Pure: returns
// sections of plain text; the page prints them. Letters contain no secrets.
// Names and the spare's location are typed at print time or left blank to be
// written by hand; nothing is stored.
import { PAGES_OFFLINE, PAGES_ONLINE } from './config.js';

const BLANK = '______________________________________';

/**
 * @param p { address, accountLabel?, belongsTo?, network, offlineSha256 }
 * @returns { title, sections: [{ heading, paragraphs: [string | { bold: string }], list?: string[] }], appendix: [...] }
 */
export function estateLetter(p) {
  const who = p.belongsTo && p.belongsTo.trim() ? p.belongsTo.trim() : BLANK;
  const label = p.accountLabel && p.accountLabel.trim() ? p.accountLabel.trim() : 'this account';
  const net = p.network === 'testnet' ? 'TESTNET (practice network, no real value)' : 'the XRP Ledger (mainnet)';
  return {
    title: `XRP account letter: ${label}`,
    sections: [
      { heading: 'What this is', paragraphs: [
        `This letter is about one XRP account on ${net}. It contains no passwords or secret keys.`,
        'The account can be moved only with its spare key, which is kept on a separate paper card. Whoever holds that card can move the funds, so treat it like cash.',
      ] },
      { heading: 'The account', paragraphs: [
        `Account address: ${p.address}`,
        `It belongs to: ${who}`,
        `The spare key card is kept at: ${BLANK}`,
        `${BLANK}`,
      ] },
      { heading: 'The two programs you need', paragraphs: [
        `Online Builder (on a normal computer): ${PAGES_ONLINE}`,
        `Offline Signer (on a laptop with Wi-Fi off): ${PAGES_OFFLINE}`,
        `Before opening the Offline Signer, check its SHA-256 fingerprint is exactly: ${p.offlineSha256}`,
        'The helper appendix shows how to check it. If it does not match, stop: do not use that file.',
      ] },
      { heading: 'Steps', list: [
        'Find someone you trust in person who is good with computers. Give them this letter and the helper appendix, not the spare card.',
        'On a normal computer, open the Online Builder, choose Estate Transfer, enter the account address above and where the funds should go. If the destination is an exchange, enter its destination tag.',
        'The Online Builder shows one or more QR codes.',
        'On a laptop with Wi-Fi turned off, open the Offline Signer (after checking its fingerprint), choose Scan an envelope, and hold the QR codes up to its webcam.',
        'Confirm the network, read the summary twice, then type the spare key from the paper card.',
        'The Offline Signer shows a signed QR code. Scan it with the Online Builder (Submit) and wait until it says Done.',
        'Check the funds arrived. After that, the spare card is no longer needed and can be destroyed.',
      ] },
      { heading: 'Destination tags', paragraphs: [
        { bold: 'Exchanges usually need a destination tag (a number) as well as the address. Sending without the right tag can lose the funds. Copy it exactly from the exchange\'s deposit page.' },
      ] },
      { heading: 'Get help', paragraphs: [
        { bold: 'You will probably need someone good with computers. Pick someone you trust in person.' },
      ] },
    ],
    appendix: helperAppendix(p),
  };
}

function helperAppendix(p) {
  return [
    { heading: 'Helper appendix (for the person helping)', paragraphs: [
      { bold: 'Nobody legitimate will ever ask for the spare key remotely, over the phone or online. "Wallet recovery services" that ask for it are theft. Be physically present. Type the spare only into the Offline Signer on a laptop with Wi-Fi off.' },
    ] },
    { heading: 'Check the Offline Signer file', paragraphs: [
      `Download it from ${PAGES_OFFLINE}, copy it to the laptop, then turn Wi-Fi off before opening it.`,
      'Compute its SHA-256 and compare every character with:',
      p.offlineSha256,
    ], list: [
      'Linux: sha256sum icecold-v3-offline.html',
      'macOS: shasum -a 256 icecold-v3-offline.html',
      'Windows (Command Prompt): certutil -hashfile icecold-v3-offline.html SHA256',
    ] },
    { heading: 'What each screen should look like', list: [
      'Offline Signer at start: a green "Self-test passed" bar. A red bar means stop.',
      'A large coloured network bar: red MAINNET or blue TESTNET. It must match the network you expect.',
      'Estate Transfer asks you to pick the network, then shows the summary twice, then asks for the spare.',
      'If the spare is typed with a mistake, it offers corrections and marks the one that belongs to this account.',
      'Online Builder Submit: scan the signed code; it checks it and says Done when the ledger has validated it.',
    ] },
    { heading: 'Afterwards', paragraphs: [
      'Once the funds arrive at the destination, cold storage for this account is over. The spare card can be destroyed.',
    ] },
  ];
}

/** Blank Spare Key Card layout (A25): 31 boxes grouped 4-4-4-4-4-4-4-3. */
export const SPARE_CARD_GROUPS = Object.freeze([4, 4, 4, 4, 4, 4, 4, 3]);
