const admin = require("firebase-admin");
const serviceAccount = require("./pintrest-pin-videos-firebase-adminsdk-fbsvc-21ce612000.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function run() {
  try {
    const coll = db.collection("pins");
    console.log(`Querying collection: pins...`);
    const snapshot = await coll.orderBy("scrapedAt", "desc").get();
    console.log(`Total Documents: ${snapshot.size}`);

    if (snapshot.empty) {
      console.log("No documents found in 'pins' collection.");
      process.exit(0);
    }

    // Discover all fields (columns) across all docs
    const allKeys = new Set();
    const docs = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      Object.keys(data).forEach(key => allKeys.add(key));
      docs.push({ id: doc.id, ...data });
    });

    console.log(`Columns (fields): ${Array.from(allKeys).join(", ")}\n`);

    // Print table header
    const headers = ["Index", "Doc ID (Base64)", ...Array.from(allKeys)];
    const divider = headers.map(() => "---");
    console.log(`| ${headers.join(" | ")} |`);
    console.log(`| ${divider.join(" | ")} |`);

    let index = 1;
    for (const doc of docs) {
      const row = [index++];
      row.push(doc.id);
      for (const key of allKeys) {
        let val = doc[key];
        if (val === undefined || val === null) {
          val = "";
        } else if (typeof val === "object") {
          val = JSON.stringify(val);
        } else {
          val = String(val);
        }
        // Truncate long values like URLs/JSON to look nice in the terminal/logs
        if (val.length > 80) {
          val = val.substring(0, 77) + "...";
        }
        // Escape vertical pipes
        val = val.replace(/\|/g, "\\|");
        row.push(val);
      }
      console.log(`| ${row.join(" | ")} |`);
    }
    process.exit(0);
  } catch (error) {
    console.error("Error inspecting database:", error);
    process.exit(1);
  }
}

run();
