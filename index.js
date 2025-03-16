const express = require('express');
const admin = require('firebase-admin');
const { FieldValue } = admin.firestore;  // Add this import for FieldValue

// Path to your service account key JSON file
const serviceAccount = require('./serviceAccountKey.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Get Firestore instance
const db = admin.firestore();
const messaging = admin.messaging();
// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

app.post('/api/store-fcm', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const devicesRef = db.collection('noti_devices');
    const snapshot = await devicesRef.where('token', '==', token).get();

    const now = new Date();
    const TTL_DURATION = 24 * 60 * 60 * 1000; // 24 hours
    const newTTL = new Date(now.getTime() + TTL_DURATION);

    let docRef;

    if (snapshot.empty) {
      // Token not found: create new document
      const newDoc = {
        token,
        created_at: now,
        updated_at: now,
        time_to_live: newTTL
      };
      docRef = await devicesRef.add(newDoc);
      return res.status(201).json({ id: docRef.id, message: 'New document created' });
    } else {
      // Token found: update existing document
      let doc = snapshot.docs[0]; // Get the first matching document
      docRef = doc.ref;

      await docRef.update({
        updated_at: now,
        time_to_live: newTTL
      });

      return res.status(200).json({ id: docRef.id, message: 'Document updated' });
    }
  } catch (error) {
    console.error('Error writing to Firestore:', error);
    return res.status(500).json({ error: 'Error storing data', details: error.message });
  }
});

app.post('/api/update-status', async (req, res) => {
    try {
      const { token, campaignId } = req.body;
  
      // Validate required fields
      if (!token || !campaignId) {
        return res.status(400).json({ 
          error: 'Bad Request', 
          message: 'FCM token and campaign ID are required' 
        });
      }
  
      // Reference to notifications collection
      const notificationsRef = db.collection('noti_notifications');
      
      // Query for notification with matching token and campaignId
      const snapshot = await notificationsRef
        .where('fcmToken', '==', token)
        .where('campaignId', '==', campaignId)
        .limit(1)
        .get();
  
      if (snapshot.empty) {
        return res.status(404).json({ 
          error: 'Not Found', 
          message: 'No notification found for the provided token and campaign ID' 
        });
      }
  
      // Get the notification document reference
      const notificationDoc = snapshot.docs[0];
      const notificationRef = notificationDoc.ref;
      
      // Update the notification status and timestamp
      await notificationRef.update({
        status: 'delivered',
        delivered_at: admin.firestore.FieldValue.serverTimestamp()
      });
  
      return res.status(200).json({ 
        success: true, 
        message: 'Notification status updated to delivered',
        id: notificationDoc.id
      });
    } catch (error) {
      console.error('Error updating notification status:', error);
      
      // Better error handling with appropriate status codes
      const statusCode = error.code === 'permission-denied' ? 403 : 500;
      return res.status(statusCode).json({
        error: 'Failed to update notification',
        message: error.message,
        code: error.code || 'unknown'
      });
    }
});
  

app.get('/api/check-campaigns', async (req, res) => {
  try {
    const campaignsRef = db.collection("noti_campaigns");
    const now = admin.firestore.Timestamp.now();

    // Fetch pending campaigns that are scheduled to be sent
    const snapshot = await campaignsRef
      .where("status", "==", "pending")
      .where("send_at", "<=", now)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "No pending campaigns found" });
    }

    const campaigns = snapshot.docs.map((doc) => {
      const data = doc.data();
      return { id: doc.id, ...data };
    });

    // Process each campaign
    const results = [];
    for (const campaign of campaigns) {
      try {
        const { id, title, text: body, image: img } = campaign;

        // Fetch all device tokens
        const devicesSnapshot = await db.collection("noti_devices").get();
        const tokens = devicesSnapshot.docs
          .map((doc) => doc.data().token)
          .filter(Boolean);

        if (tokens.length === 0) {
          results.push({ campaignId: id, status: "failed", message: "No devices found" });
          continue; // Skip to the next campaign
        }

        // Create the FCM message payload
        const message = {
          notification: { title, body, image: img },
          tokens, // Send to multiple devices
        };

        // Send the notification
        const response = await messaging.sendEachForMulticast(message);

        // Track success and failures
        const successCount = response.successCount;
        const failureCount = response.failureCount;
        const failedTokens = [];
        const notificationsData = [];
        const failedReasons = {};

        response.responses.forEach((res, idx) => {
          const status = res.success ? "success" : "failed";
          const deviceToken = tokens[idx];

          if (deviceToken) {
            // Create notification record
            const notificationData = {
              campaignId: id,
              fcmToken: deviceToken,
              status,
              timestamp: new Date(),
            };
            notificationsData.push(notificationData);

            if (!res.success && res.error) {
              const reason = res.error.code || "Unknown";
              failedTokens.push({ token: deviceToken, error: reason });
              failedReasons[reason] = (failedReasons[reason] || 0) + 1;
            }
          }
        });

        // Store notifications in Firestore using batch write
        if (notificationsData.length > 0) {
          const batch = db.batch();
          notificationsData.forEach((notification) => {
            const notificationRef = db.collection("noti_notifications").doc();
            batch.set(notificationRef, notification);
          });
          await batch.commit();
        }

        // Update campaign metrics in Firestore
        const campaignRef = db.collection("noti_campaigns").doc(id);
        await campaignRef.update({
          sent_count: FieldValue.increment(tokens.length),
          success_count: FieldValue.increment(successCount),
          failed_count: FieldValue.increment(failureCount),
          failed_reasons: failedReasons,
          status: "completed", // Mark campaign as completed
        });

        results.push({
          campaignId: id,
          status: "success",
          successCount,
          failureCount,
          totalSent: tokens.length,
          failuresByReason: failedReasons,
        });
      } catch (error) {
        console.error(`Error processing campaign ${campaign.id}:`, error);
        results.push({
          campaignId: campaign.id,
          status: "failed",
          error: error.message,
        });
      }
    }

    return res.json({
      message: `Processed ${campaigns.length} campaigns`,
      results,
    });
  } catch (error) {
    console.error("Error checking campaigns:", error);
    return res.status(500).json({
      error: error.message,
      message: "Error checking campaigns",
    });
  }
});
const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
 