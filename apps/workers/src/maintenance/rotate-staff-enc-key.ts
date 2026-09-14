import { STAFF, rotatePhoneKeys } from './rotate-phone-keys.js';

/** Staff numbers (transfer targets, inbound fallback forwards) from one STAFF_ENC_* pair to the next. */
await rotatePhoneKeys('rotate-staff-enc-key', STAFF);
