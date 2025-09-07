require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");

const router = express.Router();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

// Only initialize Twilio client if credentials are available
const client = (accountSid && authToken) ? twilio(accountSid, authToken) : null;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
    console.error("❌ Error: GOOGLE_API_KEY is missing in environment variables.");
    process.exit(1);
}

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_API_KEY}`;

// **Generate the AI Prompt**
const generatePrompt = (conversation, summary) =>
    `
    You are an AI interviewer evaluating a candidate's interview performance based on their conversation. Provide a structured evaluation.

    **Interview Transcript:**
    ${JSON.stringify(conversation, null, 2)}

    **Candidate Summary:** 
    ${summary}

    **Evaluation Criteria:**
    - "strengths": List key strengths based on the conversation.
    - "areasForImprovement": Highlight areas that need improvement.
    - "detailedFeedback": Provide ratings and insights on:
      - "Technical Skills"
      - "Communication Skills"
      - "Problem-Solving Ability"
      - "Team Collaboration"
    - "finalDecision":
      - "decision": "Accepted" or "Rejected"
      - "ratings": Rate each category (1-5).
      - "confidenceScore": How confident you are in this decision.
    - "additionalInsights":
      - "sentimentAnalysis": Emotional tone of the conversation.
      - "recommendedResources": Learning materials based on weak areas.
      - "alternateRoleSuggestions": Other potential roles for the candidate.

    **Return JSON only (no extra text, no markdown formatting):**
    \`\`\`json
    {
        "strengths": ["Technical Related",],
        "areasForImprovement": ["Realated to Technical Improvements"],
        "detailedFeedback": {
            "Technical Skills": "Strong in algorithms, weak in databases",
            "Communication Skills": "Clear but hesitant",
            "Problem-Solving Ability": "Logical but slow",
            "Team Collaboration": "Not enough data"
        },
        "finalDecision": {
            "decision": "Accepted/Rejected",
            "ratings": {
                "Technical Skills": 4,
                "Communication Skills": 3,
                "Problem-Solving": 4,
                "Experience Level": 3
            },
            "confidenceScore": "High"
        },
        "additionalInsights": {
            "sentimentAnalysis": {
                "overallSentiment": "Positive",
                "emotionalTone": "Confident"
            },
            "recommendedResources": [
                {
                    "topic": "Database Optimization",
                    "resource": "https://www.some-resource.com"
                }
            ],
            "alternateRoleSuggestions": ["Data Analyst", "Backend Engineer"]
        }
    }
    \`\`\`
    `;

// **POST Route to Evaluate the Interview**
router.post("/", async (req, res) => {
    try {
        console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));
        
        const { conversation, summary, phoneNumber } = req.body;

        // Validate input
        if (!conversation || !summary || !Array.isArray(conversation) || typeof summary !== "string") {
            console.log("❌ Validation failed:", {
                conversation: conversation,
                summary: summary,
                isArray: Array.isArray(conversation),
                summaryType: typeof summary
            });
            return res.status(400).json({ message: "Invalid input. 'conversation' must be an array and 'summary' must be a string." });
        }

        // Convert conversation array of strings to array of objects if needed
        let processedConversation = conversation;
        if (conversation.length > 0 && typeof conversation[0] === 'string') {
            // Convert array of strings to array of objects
            processedConversation = conversation.map((line, index) => {
                // Try to detect speaker from line content
                if (line.toLowerCase().includes('ai') || line.toLowerCase().includes('interviewer')) {
                    return { speaker: 'AI_HR', text: line };
                } else if (line.toLowerCase().includes('candidate') || line.toLowerCase().includes('applicant')) {
                    return { speaker: 'Candidate', text: line };
                } else {
                    // Default to alternating speakers
                    return { speaker: index % 2 === 0 ? 'AI_HR' : 'Candidate', text: line };
                }
            });
        }

        // Phone number validation only if Twilio is configured
        if (client && process.env.TWILIO_PHONE_NUMBER) {
            // Only validate if phone number is provided and not empty
            if (phoneNumber && phoneNumber.trim() !== "") {
                if (typeof phoneNumber !== "string") {
                    console.log("❌ Phone number validation failed: invalid phone number type");
                    return res.status(400).json({ message: "Phone number must be a string in E.164 format (e.g., +1234567890)" });
                }

                // Clean phone number by removing spaces and other non-digit characters except +
                const cleanedPhoneNumber = phoneNumber.replace(/[^\d+]/g, '');
                console.log("📞 Original phone number:", phoneNumber);
                console.log("📞 Cleaned phone number:", cleanedPhoneNumber);

                // Basic E.164 format validation
                const phoneRegex = /^\+[1-9]\d{1,14}$/;
                if (!phoneRegex.test(cleanedPhoneNumber)) {
                    console.log("❌ Phone number format validation failed:", cleanedPhoneNumber);
                    return res.status(400).json({ message: "Invalid phone number format. Must be in E.164 format (e.g., +1234567890)" });
                }
                console.log("✅ Phone number validation passed:", cleanedPhoneNumber);
            } else {
                console.log("ℹ️ No phone number provided, skipping SMS notification");
            }
        } else {
            console.log("ℹ️ Twilio not configured, skipping phone number validation");
            // If phone number is provided but Twilio is not configured, just log it
            if (phoneNumber && phoneNumber.trim() !== "") {
                console.log("📞 Phone number provided but Twilio not configured:", phoneNumber);
            }
        }

        const prompt = generatePrompt(processedConversation, summary);

        let existingData = processedConversation;

        const filePath = path.join(__dirname, "../data/interviews.json");

        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            try {
                existingData = JSON.parse(fileContent);
            } catch (err) {
                console.error("⚠️ Failed to parse existing JSON. Overwriting...");
            }
        }


        // Save back to file
        fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2), "utf-8");

        // **Send API Request**
        console.log("🔑 Using Google API Key:", GOOGLE_API_KEY ? "Present" : "Missing");
        console.log("🌐 Making request to:", GEMINI_API_URL);
        
        if (!GOOGLE_API_KEY) {
            console.log("❌ Google API Key is missing!");
            return res.status(500).json({
                error: "Google API Key is not configured",
                details: "Please set GOOGLE_API_KEY environment variable"
            });
        }
        
        const response = await axios.post(
            GEMINI_API_URL,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { "Content-Type": "application/json" } }
        );

        console.log("🔹 Raw API Response:", JSON.stringify(response.data, null, 2));

        let rawContent = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

        // **Sanitize AI Response**
        rawContent = rawContent
            .replace(/```json/g, "") // Remove Markdown JSON block
            .replace(/```/g, "") // Remove closing Markdown
            .trim();

        console.log("📝 Sanitized JSON String:", rawContent);

        let evaluation;
        try {
            evaluation = JSON.parse(rawContent); // Parse JSON
            
            // Validate required fields
            if (!evaluation.strengths || !evaluation.areasForImprovement || 
                !evaluation.detailedFeedback || !evaluation.finalDecision) {
                throw new Error('Missing required fields in evaluation');
            }

            // Ensure ratings are numbers between 1-5
            const ratings = evaluation.finalDecision.ratings;
            for (let key in ratings) {
                ratings[key] = Math.max(1, Math.min(5, Number(ratings[key])));
            }

        } catch (jsonError) {
            console.error("❌ JSON Parsing Error:", jsonError);
            return res.status(500).json({
                error: "Failed to process evaluation",
                details: jsonError.message
            });
        }

        // Send decision via Twilio (only if configured)
        if (client && process.env.TWILIO_PHONE_NUMBER && phoneNumber && phoneNumber.trim() !== "") {
            try {
                // Clean phone number for Twilio
                const cleanedPhoneNumber = phoneNumber.replace(/[^\d+]/g, '');
                const decisionText = `Interview Decision: ${evaluation.finalDecision.decision}`;
                const message = await client.messages.create({
                    body: decisionText,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: cleanedPhoneNumber
                });
                console.log("📲 Twilio Message Sent:", message.sid);
            } catch (twilioError) {
                console.error("❌ Failed to send SMS via Twilio:", twilioError.message);
                // Don't fail the request if Twilio fails
            }
        }

        // Return only the evaluation data
        return res.json(evaluation);

    } catch (error) {
        console.error("❌ API Error:", error);
        return res.status(500).json({
            error: "Failed to process evaluation",
            details: error.message
        });
    }
});

module.exports = router;
