const { db: firestoreDb } = require("./firebase");

console.log("Database Layer: Running in Pure Firestore Mode 🌐");

async function upsertPin(pin) {
  try {
    let pinUrl = pin.pinUrl;
    if (!pinUrl) return;
    pinUrl = pinUrl.split('?')[0].replace(/\/$/, "");
    pin.pinUrl = pinUrl; // normalize the saved data too
    const docId = Buffer.from(pinUrl).toString('base64');
    if (!pin.createdAt) pin.createdAt = new Date().toISOString();
    await firestoreDb.collection("pins").doc(docId).set(pin, { merge: true });
  } catch (error) {
    console.error("Firestore upsert failed:", error.message);
  }
}

async function getAllPins() {
  try {
    const snapshot = await firestoreDb.collection("pins").orderBy("createdAt", "desc").limit(1000).get();
    const pins = [];
    snapshot.forEach(doc => pins.push(doc.data()));
    return pins;
  } catch (error) {
    console.error("Firestore getAllPins failed:", error.message);
    return [];
  }
}

async function searchPins(query) {
  try {
    const q = query.toLowerCase();
    const snapshot = await firestoreDb.collection("pins").orderBy("createdAt", "desc").get();
    const pins = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if ((data.title && data.title.toLowerCase().includes(q)) || 
          (data.author && data.author.toLowerCase().includes(q)) || 
          (data.pinUrl && data.pinUrl.toLowerCase().includes(q))) {
        pins.push(data);
      }
    });
    return pins.slice(0, 100);
  } catch (error) {
    console.error("Firestore searchPins failed:", error.message);
    return [];
  }
}

async function getLatestPin() {
  try {
    const batchQuery = await firestoreDb.collection("pins").orderBy("scrapedAt", "desc").limit(1).get();
    if (!batchQuery.empty) {
      return batchQuery.docs[0].data();
    }
    return null;
  } catch (error) {
    console.error("Firestore getLatestPin failed:", error.message);
    return null;
  }
}

async function getPinsByBatch(batchId) {
  try {
    const snapshot = await firestoreDb.collection("pins").where("batchId", "==", batchId).get();
    const pins = [];
    snapshot.forEach(doc => pins.push(doc.data()));
    return pins;
  } catch (error) {
    console.error("Firestore getPinsByBatch failed:", error.message);
    return [];
  }
}

async function saveBatchPins(pins, newBatchId, timestamp) {
  try {
    let batch = firestoreDb.batch();
    let opCount = 0;
    
    for (const pin of pins) {
      if (pin.pinUrl) {
        pin.pinUrl = pin.pinUrl.split('?')[0].replace(/\/$/, "");
      }
      const docId = Buffer.from(pin.pinUrl).toString("base64");
      const docRef = firestoreDb.collection("pins").doc(docId);
      batch.set(docRef, {
        ...pin,
        batchId: newBatchId,
        scrapedAt: timestamp,
        createdAt: timestamp
      }, { merge: true });
      
      opCount++;
      if (opCount === 500) {
        await batch.commit();
        batch = firestoreDb.batch();
        opCount = 0;
      }
    }
    if (opCount > 0) {
      await batch.commit();
    }
    
    // Delete all older pins (everything before this new batch)
    console.log(`[db] Deleting all old Firestore pins (keeping only new batch)...`);
    const oldDocsQuery = await firestoreDb.collection("pins").where("scrapedAt", "<", timestamp).get();
    batch = firestoreDb.batch();
    opCount = 0;
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
  } catch (error) {
    console.error("Firestore saveBatchPins failed:", error.message);
  }
}

async function clearAllVideoData() {
  try {
    console.log('[db] Clearing all cached videoSrc/qualities from Firestore...');
    const snapshot = await firestoreDb.collection('pins').get();
    let batch = firestoreDb.batch();
    let opCount = 0;
    let totalCleared = 0;
    snapshot.forEach(doc => {
      batch.update(doc.ref, {
        videoSrc: firestoreDb.FieldValue?.delete() || '',
        qualities: [],
        linksRefreshedAt: null
      });
      opCount++;
      totalCleared++;
      if (opCount === 500) {
        batch.commit();
        batch = firestoreDb.batch();
        opCount = 0;
      }
    });
    if (opCount > 0) await batch.commit();
    console.log(`[db] Cleared video data for ${totalCleared} pins.`);
    return totalCleared;
  } catch (error) {
    console.error('Firestore clearAllVideoData failed:', error.message);
    return 0;
  }
}

async function deletePin(pinUrl) {
  try {
    if (!pinUrl) return;
    const docId = Buffer.from(pinUrl).toString('base64');
    await firestoreDb.collection("pins").doc(docId).delete();
    console.log(`[db] Deleted pin from Firestore: ${pinUrl}`);
  } catch (error) {
    console.error("Firestore deletePin failed:", error.message);
  }
}

module.exports = {
  upsertPin,
  getAllPins,
  searchPins,
  getLatestPin,
  getPinsByBatch,
  saveBatchPins,
  clearAllVideoData,
  deletePin
};

