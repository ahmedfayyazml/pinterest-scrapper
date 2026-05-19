require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_KEY_PATH || './serviceAccountKey.json';

try {
  const serviceAccount = require(path.resolve(serviceAccountPath));
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  console.log('Firebase initialized successfully.');
} catch (e) {
  console.error('Firebase initialization failed. Make sure FIREBASE_KEY_PATH is correct or serviceAccountKey.json exists.', e.message);
}

const db = admin.firestore();

module.exports = { admin, db };
