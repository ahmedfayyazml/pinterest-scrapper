const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const admin = require('firebase-admin');

const serviceAccountPath = process.env.FIREBASE_KEY_PATH || './serviceAccountKey.json';

try {
  const absoluteServiceAccountPath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.resolve(__dirname, serviceAccountPath);
  const serviceAccount = require(absoluteServiceAccountPath);
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

