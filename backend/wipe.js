const admin = require("firebase-admin");
const serviceAccount = require("./pintrest-pin-videos-firebase-adminsdk-fbsvc-21ce612000.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestoreDb = admin.firestore();

async function wipeAllPins() {
  console.log("Wiping all old feed data...");
  const oldDocsQuery = await firestoreDb.collection("pins").get();
  
  let batch = firestoreDb.batch();
  let opCount = 0;
  
  oldDocsQuery.forEach(doc => {
    batch.delete(doc.ref);
    opCount++;
    if (opCount === 500) {
      batch.commit();
      batch = firestoreDb.batch();
      opCount = 0;
    }
  });
  
  if (opCount > 0) {
    await batch.commit();
  }
  
  console.log("Successfully deleted " + oldDocsQuery.size + " pins.");
  process.exit(0);
}

wipeAllPins();
