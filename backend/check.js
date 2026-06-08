const admin = require("firebase-admin");
const serviceAccount = require("./pintrest-pin-videos-firebase-adminsdk-fbsvc-21ce612000.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestoreDb = admin.firestore();

async function check() {
  const snapshot = await firestoreDb.collection("pins").orderBy("scrapedAt", "desc").limit(3).get();
  const pins = [];
  snapshot.forEach(doc => pins.push(doc.data()));
  console.log(JSON.stringify(pins, null, 2));
  process.exit(0);
}

check();
