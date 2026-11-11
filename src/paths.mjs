import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** The data folder: --dir, else $HOLDEM_DUET_DIR, else ~/.holdem-duet. */
export const dataDir = (given) => resolve(given ?? process.env.HOLDEM_DUET_DIR ?? join(homedir(), '.holdem-duet'));
