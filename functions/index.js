// Cloud Function skeleton to process archiveJobs collection.
// Deploy with Firebase Functions. This function listens to new archiveJobs
// documents with status 'pending', copies the referenced storage object into
// products/{productId}/archive/, and then deletes the original object.

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const storage = admin.storage();
const db = admin.firestore();

exports.processArchiveJob = functions.firestore
  .document('archiveJobs/{jobId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data || !data.url || !data.productId) return null;
    const jobRef = snap.ref;

    try {
      // Update status -> processing
      await jobRef.update({ status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() });

      // Derive storage path from download URL (best-effort)
      // This assumes files were uploaded to the default bucket and are publicly accessible download URLs.
      const url = data.url;
      // Example download URL formats vary; attempt to extract the path after /o/ and decode
      const match = url.match(/\/o\/(.+)\?alt=media/);
      let path = null;
      if (match && match[1]) {
        path = decodeURIComponent(match[1]);
      }

      if (!path) {
        // cannot process: mark failed
        await jobRef.update({ status: 'failed', error: 'could-not-derive-path' });
        return null;
      }

      const bucket = storage.bucket();
      const srcFile = bucket.file(path);

      // Prepare destination: products/{productId}/archive/{basename}
      const parts = path.split('/');
      const basename = parts[parts.length - 1];
      const destPath = `products/${data.productId}/archive/${basename}`;
      const destFile = bucket.file(destPath);

      // Copy source to dest
      await srcFile.copy(destFile);
      // Delete original
      await srcFile.delete().catch(() => {});

      await jobRef.update({ status: 'done', doneAt: admin.firestore.FieldValue.serverTimestamp(), destPath });
    } catch (err) {
      console.error('processArchiveJob error', err);
      try { await jobRef.update({ status: 'failed', error: String(err) }); } catch (e) {}
    }
    return null;
  });
