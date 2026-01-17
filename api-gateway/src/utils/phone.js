'use strict';

const COUNTRY_CALLING = {
  CI: '225',
  BF: '226',
  ML: '223',
  SN: '221',
  CM: '237',
  BJ: '229',
  TG: '228',
};

const digitsOnly = (s) => String(s || '').replace(/[^\d]/g, '');

function toE164(phone, country) {
  const raw = String(phone || '').trim();
  if (!raw) return { e164: '', digits: '' };

  // Déjà E.164
  if (raw.startsWith('+')) {
    const digits = digitsOnly(raw);
    // E.164: 7 à 15 digits (hors +)
    if (digits.length < 7 || digits.length > 15) return { e164: '', digits: '' };
    return { e164: `+${digits}`, digits };
  }

  const key = String(country || '').toUpperCase().trim();
  const cc = COUNTRY_CALLING[key];
  const d = digitsOnly(raw);

  if (!cc || !d) return { e164: '', digits: '' };

  // Construction +<callingCode><digits>
  const digits = `${cc}${d}`;

  // E.164: 7 à 15 digits (hors +)
  if (digits.length < 7 || digits.length > 15) return { e164: '', digits: '' };

  return { e164: `+${digits}`, digits };
}

module.exports = { digitsOnly, toE164, COUNTRY_CALLING };
