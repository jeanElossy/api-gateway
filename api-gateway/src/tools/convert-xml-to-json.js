const fs = require('fs');
const xml2js = require('xml2js');

// Chemins à adapter selon ton fichier/dossier
const xmlFilePath = './sdn_enhanced.xml'; // Mets ici le nom de ton fichier XML
const jsonFilePath = './sdn_enhanced.json'; // Nom du fichier de sortie JSON

// Optionnel : paramétrage du parser
const parserOptions = {
  explicitArray: false, // Pour ne pas mettre chaque propriété dans un tableau si pas utile
  mergeAttrs: true,     // Pour fusionner les attributs XML dans les objets
};

fs.readFile(xmlFilePath, (err, data) => {
  if (err) {
    console.error('❌ Erreur de lecture du fichier XML:', err);
    process.exit(1);
  }

  xml2js.parseString(data, parserOptions, (err, result) => {
    if (err) {
      console.error('❌ Erreur de parsing XML:', err);
      process.exit(1);
    }

    fs.writeFile(jsonFilePath, JSON.stringify(result, null, 2), (err) => {
      if (err) {
        console.error('❌ Erreur d\'écriture JSON:', err);
        process.exit(1);
      }
      console.log(`✅ Conversion terminée ! Fichier JSON généré : ${jsonFilePath}`);
    });
  });
});
