const admin = require("firebase-admin");
const serviceAccount = require("./pintrest-pin-videos-firebase-adminsdk-fbsvc-21ce612000.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestoreDb = admin.firestore();

async function dump() {
  const snapshot = await firestoreDb.collection("pins").orderBy("scrapedAt", "desc").limit(200).get();
  console.log(`| Index | Title | Author | Video URL Attached? |`);
  console.log(`|---|---|---|---|`);
  let i = 1;
  snapshot.forEach(doc => {
    const pin = doc.data();
    const title = pin.title ? pin.title.substring(0, 50).replace(/\|/g, '') + '...' : 'No Title';
    const author = pin.author || 'Pinterest';
    const videoState = pin.videoSrc ? '✅ Yes' : '⏳ Fetching...';
    console.log(`| ${i++} | [${title}](${pin.pinUrl}) | ${author} | ${videoState} |`);
  });
  process.exit(0);
}

dump();
