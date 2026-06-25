const { db: firestoreDb } = require("./firebase");
const fs = require("fs");
const path = require("path");

console.log("Database Layer: Running in Pure Firestore Mode 🌐");

async function upsertPin(pin) {
  try {
    const pinUrl = pin.pinUrl;
    if (!pinUrl) return;
    const docId = Buffer.from(pinUrl).toString('base64');
    if (!pin.createdAt) pin.createdAt = new Date().toISOString();
    await firestoreDb.collection("pins").doc(docId).set(pin, { merge: true });
  } catch (error) {
    console.error("Firestore upsert failed:", error.message);
  }
}

async function deletePin(pinUrl) {
  try {
    if (!pinUrl) return;
    const docId = Buffer.from(pinUrl).toString('base64');
    await firestoreDb.collection("pins").doc(docId).delete();
  } catch (error) {
    console.error("Firestore deletePin failed:", error.message);
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
  const cutoffTime = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();

  try {
    let batch = firestoreDb.batch();
    let opCount = 0;
    
    for (const pin of pins) {
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
  } catch (error) {
    console.error("Firestore saveBatchPins failed:", error.message);
  }
}

async function deleteOldBatches(currentBatchId) {
  const cutoffTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  
  try {
    const allPins = await firestoreDb.collection("pins").get();
    let batch = firestoreDb.batch();
    let opCount = 0;
    
    let currentBatchPins = [];

    allPins.forEach(doc => {
      const data = doc.data();
      const isOldBatch = data.batchId && data.batchId !== currentBatchId;
      const isOlderThan48h = data.scrapedAt && data.scrapedAt < cutoffTime;
      
      if (isOldBatch || isOlderThan48h) {
        batch.delete(doc.ref);
        opCount++;
        if (opCount === 500) {
          batch.commit();
          batch = firestoreDb.batch();
          opCount = 0;
        }
      } else if (data.batchId === currentBatchId) {
        currentBatchPins.push(data);
      }
    });
    
    if (opCount > 0) {
      await batch.commit();
    }

    const mediaDir = '/var/www/vectorsbit-pinterest/backend/media';
    if (fs.existsSync(mediaDir)) {
      const files = fs.readdirSync(mediaDir);
      const currentPinIds = new Set(currentBatchPins.map(p => {
        return p.pinId || p.pinUrl?.split("/pin/")[1]?.replace(/\//g, "") || "";
      }));
      let deletedFiles = 0;
      files.forEach(file => {
        const pinId = file.replace('.mp4', '');
        if (!currentPinIds.has(pinId)) {
          fs.unlinkSync(path.join(mediaDir, file));
          deletedFiles++;
        }
      });
      console.log(`[cleanup] Deleted ${deletedFiles} old media files`);
    }

  } catch (error) {
    console.error("Firestore deleteOldBatches failed:", error.message);
  }
}

async function resetFailedPins() {
  try {
    const batchQuery = await firestoreDb.collection("pins").orderBy("scrapedAt", "desc").limit(1).get();
    if (batchQuery.empty) return 0;
    
    const currentBatchId = batchQuery.docs[0].data().batchId;
    const snapshot = await firestoreDb.collection("pins")
      .where("batchId", "==", currentBatchId)
      .where("resolveStatus", "==", "failed")
      .get();
      
    if (snapshot.empty) return 0;
    
    let batch = firestoreDb.batch();
    let count = 0;
    
    snapshot.forEach(doc => {
      batch.update(doc.ref, {
        resolveStatus: null,
        errorLog: null,
        videoSrc: null
      });
      count++;
    });
    
    await batch.commit();
    return count;
  } catch (error) {
    console.error("Firestore resetFailedPins failed:", error.message);
    return 0;
  }
}

module.exports = {
  upsertPin,
  deletePin,
  getAllPins,
  searchPins,
  getLatestPin,
  getPinsByBatch,
  saveBatchPins,
  deleteOldBatches,
  resetFailedPins
};
