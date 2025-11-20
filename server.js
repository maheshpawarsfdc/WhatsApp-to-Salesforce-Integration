// WhatsApp to Salesforce Conversational Bot with Message History
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const jsforce = require('jsforce');

const app = express();
app.use(express.json());

// Load environment variables
const {
  SALESFORCE_LOGIN_URL,
  SALESFORCE_USERNAME,
  SALESFORCE_PASSWORD,
  SALESFORCE_SECURITY_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  PORT = 3000
} = process.env;

// In-memory storage for conversation states and history
const conversations = new Map();
const messageHistory = new Map(); // Store all messages per phone number

// Salesforce connection
let sfConnection = null;

// Conversation stages
const STAGES = {
  INITIAL: 'INITIAL',
  ASKED_FIRST_NAME: 'ASKED_FIRST_NAME',
  ASKED_LAST_NAME: 'ASKED_LAST_NAME',
  ASKED_EMAIL: 'ASKED_EMAIL',
  ASKED_PHONE: 'ASKED_PHONE',
  ASKED_REQUIREMENT: 'ASKED_REQUIREMENT',
  COMPLETED: 'COMPLETED'
};

// Initialize Salesforce connection
async function connectToSalesforce() {
  try {
    console.log('🔄 Connecting to Salesforce...');
    const conn = new jsforce.Connection({
      loginUrl: SALESFORCE_LOGIN_URL
    });
    
    await conn.login(
      SALESFORCE_USERNAME,
      SALESFORCE_PASSWORD + SALESFORCE_SECURITY_TOKEN
    );
    
    sfConnection = conn;
    console.log('✅ Salesforce connected successfully!');
    return true;
  } catch (error) {
    console.error('❌ Salesforce connection failed:', error.message);
    return false;
  }
}

// Store message in history
function storeMessage(phoneNumber, sender, message, timestamp = new Date()) {
  if (!messageHistory.has(phoneNumber)) {
    messageHistory.set(phoneNumber, []);
  }
  
  messageHistory.get(phoneNumber).push({
    sender: sender, // 'customer' or 'bot' or 'sales'
    message: message,
    timestamp: timestamp.toISOString()
  });
}

// Webhook verification endpoint (required by Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('📞 Webhook verification request received');

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Receive WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    // Acknowledge receipt immediately
    res.sendStatus(200);

    const body = req.body;

    // Check if it's a WhatsApp message
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (value?.messages) {
        const message = value.messages[0];
        const from = message.from; // User's phone number
        const messageText = message.text?.body?.trim() || '';

        console.log(`📱 Message from ${from}: "${messageText}"`);

        // Store customer message
        storeMessage(from, 'customer', messageText);

        // Handle the conversation
        await handleConversation(from, messageText);
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
  }
});

// Main conversation handler
async function handleConversation(userPhone, userMessage) {
  try {
    // Get or create conversation state
    let conversation = conversations.get(userPhone) || {
      stage: STAGES.INITIAL,
      data: {}
    };

    let reply = '';

    // Handle conversation based on current stage
    switch (conversation.stage) {
      case STAGES.INITIAL:
        reply = "👋 Hello! Welcome to our business!\n\nI'd be happy to help you. Let me collect some information.\n\nWhat is your *first name*?";
        conversation.stage = STAGES.ASKED_FIRST_NAME;
        break;

      case STAGES.ASKED_FIRST_NAME:
        conversation.data.firstName = userMessage;
        reply = `Nice to meet you, ${userMessage}! 😊\n\nWhat is your *last name*?`;
        conversation.stage = STAGES.ASKED_LAST_NAME;
        break;

      case STAGES.ASKED_LAST_NAME:
        conversation.data.lastName = userMessage;
        reply = "Great! What is your *email address*?";
        conversation.stage = STAGES.ASKED_EMAIL;
        break;

      case STAGES.ASKED_EMAIL:
        // Simple email validation
        if (!userMessage.includes('@') || !userMessage.includes('.')) {
          reply = "⚠️ That doesn't look like a valid email address. Please provide a valid email (e.g., name@example.com)";
        } else {
          conversation.data.email = userMessage;
          reply = "Perfect! What is your *phone number*?\n\n(You can share the same number you're messaging from)";
          conversation.stage = STAGES.ASKED_PHONE;
        }
        break;

      case STAGES.ASKED_PHONE:
        conversation.data.phone = userMessage;
        reply = "Almost done! 📝\n\nPlease describe your *requirement* or tell us what you're looking for.";
        conversation.stage = STAGES.ASKED_REQUIREMENT;
        break;

      case STAGES.ASKED_REQUIREMENT:
        conversation.data.requirement = userMessage;
        conversation.data.whatsappNumber = userPhone;
        
        // Create lead in Salesforce
        console.log('💾 Creating lead in Salesforce...');
        const leadId = await createLeadInSalesforce(conversation.data);
        
        if (leadId) {
          reply = `✅ Thank you, ${conversation.data.firstName}!\n\nWe've received your inquiry. Our sales team will contact you shortly on WhatsApp.\n\n📋 Your reference number: ${leadId}`;
          conversation.stage = STAGES.COMPLETED;
          console.log(`✅ Lead created successfully: ${leadId}`);
          
          // Clear conversation after 60 seconds
          setTimeout(() => {
            conversations.delete(userPhone);
            console.log(`🗑️ Conversation cleared for ${userPhone}`);
          }, 60000);
        } else {
          reply = "❌ Sorry, there was an error saving your information. Please try again or contact us directly.";
          console.log('❌ Failed to create lead');
        }
        break;

      case STAGES.COMPLETED:
        if (userMessage.toLowerCase() === 'restart' || userMessage.toLowerCase() === 'start') {
          conversations.delete(userPhone);
          return handleConversation(userPhone, 'Hi');
        } else {
          reply = "Your inquiry has already been submitted. Our team will reach out soon!\n\nIf you have a new inquiry, type 'restart'.";
        }
        break;
    }

    // Save conversation state
    conversations.set(userPhone, conversation);

    // Send reply to user
    await sendWhatsAppMessage(userPhone, reply);
    
    // Store bot's reply in history
    storeMessage(userPhone, 'bot', reply);

  } catch (error) {
    console.error('❌ Error in conversation handler:', error);
    await sendWhatsAppMessage(userPhone, "Sorry, something went wrong. Please try again.");
  }
}

// Create lead in Salesforce
async function createLeadInSalesforce(data) {
  try {
    if (!sfConnection) {
      await connectToSalesforce();
    }

    const leadRecord = {
      FirstName: data.firstName,
      LastName: data.lastName,
      Company: `${data.firstName} ${data.lastName}`,
      Email: data.email,
      Phone: data.phone,
      Description: data.requirement,
      LeadSource: 'WhatsApp',
      Status: 'Open - Not Contacted',
      WhatsApp_Number__c: data.whatsappNumber,
      WhatsApp_Message__c: data.requirement,
      WhatsApp_Conversation_ID__c: data.whatsappNumber
    };

    const result = await sfConnection.sobject('Lead').create(leadRecord);

    if (result.success) {
      return result.id;
    }
    return null;
  } catch (error) {
    console.error('❌ Error creating Salesforce lead:', error.message);
    return null;
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Message sent to ${to}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// NEW: API endpoint to send message from Salesforce
app.post('/api/send-message', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;

    // Validate input
    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and message are required'
      });
    }

    // Clean phone number (remove + if present, keep only digits)
    const cleanPhone = phoneNumber.replace(/\D/g, '');

    console.log(`📤 Sending message from Salesforce to ${cleanPhone}`);

    // Send WhatsApp message
    await sendWhatsAppMessage(cleanPhone, message);

    // Store message in history
    storeMessage(cleanPhone, 'sales', message);

    res.json({
      success: true,
      message: 'Message sent successfully'
    });

  } catch (error) {
    console.error('❌ Error in send-message API:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send message'
    });
  }
});

// NEW: API endpoint to get conversation history
app.get('/api/conversation-history/:phoneNumber', async (req, res) => {
  try {
    const phoneNumber = req.params.phoneNumber;
    
    // Clean phone number
    const cleanPhone = phoneNumber.replace(/\D/g, '');

    console.log(`📜 Fetching conversation history for ${cleanPhone}`);

    const history = messageHistory.get(cleanPhone) || [];

    res.json({
      success: true,
      phoneNumber: cleanPhone,
      messageCount: history.length,
      messages: history
    });

  } catch (error) {
    console.error('❌ Error fetching history:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch history'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    salesforce: sfConnection ? 'connected' : 'disconnected',
    activeConversations: conversations.size,
    storedHistories: messageHistory.size,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp to Salesforce Bot is running! 🚀');
});

// Start the server
app.listen(PORT, async () => {
  console.log('=================================');
  console.log('🚀 WhatsApp Bot Server Started!');
  console.log(`📡 Port: ${PORT}`);
  console.log('=================================');
  
  // Connect to Salesforce on startup
  await connectToSalesforce();
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  if (sfConnection) {
    sfConnection.logout();
  }
  process.exit(0);
});