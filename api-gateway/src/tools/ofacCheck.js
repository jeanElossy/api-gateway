// File: tools/ofacCheck.js

const fs = require('fs');
const xml2js = require('xml2js');

let sdnList = null;

function loadSdnList(path = './sdn_enhanced.xml') {
  return new Promise((resolve, reject) => {
    fs.readFile(path, (err, data) => {
      if (err) return reject(err);
      xml2js.parseString(data, (err, result) => {
        if (err) return reject(err);
        sdnList = result;
        resolve(sdnList);
      });
    });
  });
}

// Fonction de contrôle multi-champ (nom, iban, email, phone, pays)
async function isSanctioned({ name, iban, email, phone, country }) {
  if (!sdnList) {
    await loadSdnList();
  }
  const entries = sdnList?.sdnList?.sdnEntry || [];

  // Vérif sur le nom (firstName, lastName, aliases…)
  if (name) {
    if (entries.find(e =>
      (e.firstName && e.firstName[0]?.toLowerCase().includes(name.toLowerCase())) ||
      (e.lastName && e.lastName[0]?.toLowerCase().includes(name.toLowerCase())) ||
      (e.akaList && e.akaList[0]?.aka && e.akaList[0].aka.find(a =>
        a.firstName && a.firstName[0]?.toLowerCase().includes(name.toLowerCase())
      ))
    )) return true;
  }
  // Vérif IBAN
  if (iban) {
    for (const entry of entries) {
      if (entry.idList && entry.idList[0].id) {
        for (const id of entry.idList[0].id) {
          if (id.idType && id.idType[0].toLowerCase().includes('iban')) {
            if (id.idNumber[0] === iban) return true;
          }
        }
      }
    }
  }
  // Vérif email (si tu as ce champ)
  if (email) {
    for (const entry of entries) {
      if (
        entry.emailList && entry.emailList[0].email &&
        entry.emailList[0].email.find(e => e.toLowerCase() === email.toLowerCase())
      ) return true;
    }
  }
  // Vérif phone
  if (phone) {
    for (const entry of entries) {
      if (
        entry.phoneList && entry.phoneList[0].phone &&
        entry.phoneList[0].phone.find(p => p === phone)
      ) return true;
    }
  }
  // Vérif country (rarement bloquant, mais au cas où)
  if (country) {
    for (const entry of entries) {
      if (
        entry.addressList && entry.addressList[0].address &&
        entry.addressList[0].address.find(a =>
          a.country && a.country[0]?.toLowerCase().includes(country.toLowerCase())
        )
      ) return true;
    }
  }
  return false;
}

module.exports = { loadSdnList, isSanctioned };
