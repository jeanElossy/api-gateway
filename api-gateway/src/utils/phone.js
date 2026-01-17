'use strict';

const COUNTRY_CALLING = {
  CI: '225',
  BF: '226',
  ML: '223',
  SN: '221',
  CM: '237',
};

const digitsOnly = (s) => String(s || '').replace(/[^\d]/g, '');

function toE164(phone, country) {
  const raw = String(phone || '').trim();
  if (!raw) return { e164: '', digits: '' };

  // Déjà E.164
  if (raw.startsWith('+')) {
    const digits = digitsOnly(raw);
    return { e164: `+${digits}`, digits };
  }

  // Si on a le pays, on construit +<code><digits>
  const key = String(country || '').toUpperCase();
  const cc = COUNTRY_CALLING[key];
  const d = digitsOnly(raw);

  // CI: 10 digits (ex 0749490835) => +2250749490835
  if (cc && d) {
    const digits = `${cc}${d}`;
    return { e164: `+${digits}`, digits };
  }

  // fallback (pas idéal) : on retourne digits sans +
  const digits = d;
  return { e164: digits ? `+${digits}` : '', digits };
}

module.exports = { digitsOnly, toE164 };
