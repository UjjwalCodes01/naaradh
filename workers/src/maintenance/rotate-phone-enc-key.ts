import { CUSTOMER, rotatePhoneKeys } from './rotate-phone-keys.js';

/** Customer numbers (`contacts.phone_enc`) from one PHONE_ENC_* pair to the next. */
await rotatePhoneKeys('rotate-phone-enc-key', CUSTOMER);
