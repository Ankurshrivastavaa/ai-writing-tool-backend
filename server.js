const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { OpenAI } = require('openai');

dotenv.config();

const app = express();

// ============ MIDDLEWARE ============
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ============ MONGODB CONNECTION ============
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-writer')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB connection error:', err));

// ============ SCHEMAS ============

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  credits: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now },
  plan: { type: String, enum: ['free', 'pro'], default: 'free' }
});

const savedContentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentType: String,
  topic: String,
  content: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const SavedContent = mongoose.model('SavedContent', savedContentSchema);

// ============ OPENAI SETUP ============
const Groq = require('groq-sdk');

const openai = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ============ PROMPTS ============
const prompts = {
  linkedin: `Create a professional LinkedIn post on the topic: "{topic}". 
    The post should be engaging, include relevant emojis, and be optimized for LinkedIn engagement. 
    Keep it concise but impactful (150-250 characters). Include a call-to-action at the end.`,

  email: `Write a professional cold email on: "{topic}". 
    The email should be personable, have a clear subject line, and include a compelling reason to respond. 
    Make it concise (under 200 words) but persuasive.`,

  blog: `Write an engaging blog introduction (200-300 words) for an article about: "{topic}". 
    Hook the reader with a compelling opening, establish the problem, and hint at the solution. 
    Use conversational tone.`,

  tweet: `Create a Twitter thread (3-5 tweets) about: "{topic}". 
    Each tweet should be under 280 characters. Make it educational and engaging. 
    Number each tweet and use line breaks between tweets.`,

  description: `Write a compelling product/service description for: "{topic}". 
    Include: problem it solves, key benefits, unique value proposition. 
    Make it persuasive and concise (150-200 words).`
};

// ============ AUTH HELPERS ============

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '30d'
  });
};

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============ AUTH ROUTES ============

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      password: hashedPassword,
      credits: 10
    });

    await user.save();

    const token = generateToken(user._id);
    res.status(201).json({
      token,
      credits: 10,
      message: 'Account created successfully'
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user._id);
    res.json({
      token,
      credits: user.credits,
      plan: user.plan
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ CONTENT GENERATION ============

app.post('/api/generate', verifyToken, async (req, res) => {
  try {
    const { contentType, topic } = req.body;

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.credits <= 0) {
      return res.status(400).json({ error: 'Insufficient credits' });
    }

    const prompt = prompts[contentType];
    if (!prompt) {
      return res.status(400).json({ error: 'Invalid content type' });
    }

    const formattedPrompt = prompt.replace('{topic}', topic);

    const response = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile', messages: [
        {
          role: 'system',
          content: 'You are a professional content writer. Create high-quality, engaging content. Be creative and impactful.'
        },
        {
          role: 'user',
          content: formattedPrompt
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const content = response.choices[0].message.content;

    user.credits -= 1;
    await user.save();

    res.json({
      content,
      creditsRemaining: user.credits
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: 'Failed to generate content' });
  }
});

// ============ SAVED CONTENT ROUTES ============

// Save Content
app.post('/api/save', verifyToken, async (req, res) => {
  try {
    const { contentType, topic, content } = req.body;

    const savedContent = new SavedContent({
      userId: req.userId,
      contentType,
      topic,
      content
    });

    await savedContent.save();

    res.json({
      saved: savedContent,
      message: 'Content saved successfully'
    });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: 'Failed to save content' });
  }
});

// Get Saved Content
app.get('/api/saved', verifyToken, async (req, res) => {
  try {
    const contents = await SavedContent.find({ userId: req.userId })
      .sort({ createdAt: -1 });

    res.json(contents);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch saved content' });
  }
});

// Delete Saved Content
app.delete('/api/saved/:id', verifyToken, async (req, res) => {
  try {
    const content = await SavedContent.findById(req.params.id);

    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    if (content.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await SavedContent.deleteOne({ _id: req.params.id });

    res.json({ message: 'Content deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});

// ============ USER ROUTES ============

app.get('/api/user/credits', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    res.json({ credits: user.credits });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch credits' });
  }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});