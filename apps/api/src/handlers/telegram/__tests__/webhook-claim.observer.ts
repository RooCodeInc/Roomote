import { claimTelegramUpdate } from '../webhook-gate';

const owner = await claimTelegramUpdate(Number(process.argv[2]));
process.send?.({ claimed: owner !== null }, () => process.exit(0));
