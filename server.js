const express  = require('express');
const http     = require('http');
const socketio = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const mongoose = require('mongoose');
const fs       = require('fs');
const crypto   = require('crypto');          // ⬅ for Razorpay signature
const Razorpay = require('razorpay');        // ⬅ Razorpay SDK

const app    = express();
const server = http.createServer(app);
const io     = socketio(server);
const PORT   = process.env.PORT || 3000;

// --- MongoDB connection (Military Hotel) ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://priyanshimohanty2005_db_user:hjmswgA44d97J7xB@military-data.6fkkvhp.mongodb.net/military_hotel?retryWrites=true&w=majority&appName=Military-Data';

mongoose.connect(MONGO_URI);
mongoose.connection.on('connected', () => console.log('✅ Connected to MongoDB (Military Hotel)'));
mongoose.connection.on('error', (err) => console.error('❌ MongoDB Error:', err));

// --- Razorpay config (TEST keys for now) ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_SHeRdes0FXhxVe';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'EmWtiARdxinflEZvF0uZywvH';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// --- Schema ---
const orderSchema = new mongoose.Schema({
  orderType: String,              // dinein | takeaway | delivery
  customerName: String,
  registrationNumber: String,
  mobile: String,
  tableNumber: String,
  address: String,
  items: Array,
  total: Number,
  status: { type: String, default: 'incoming' },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Serve menu file ---
app.get('/menu.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.json'));
});

// Inventory: update menu.json
app.post('/update-menu', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'public', 'menu.json');
    const data = JSON.stringify(req.body, null, 2);
    fs.writeFile(filePath, data, 'utf8', (err) => {
      if (err) {
        console.error('Error writing menu.json:', err);
        return res.status(500).json({ error: 'Failed to save menu' });
      }
      res.json({ success: true });
    });
  } catch (e) {
    console.error('Error in /update-menu:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Utility: IST date boundaries ---
function getISTDateBounds(dateStr) {
  const date  = dateStr || new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(date + 'T00:00:00+05:30'));
  const end   = new Date(Date.parse(date + 'T23:59:59+05:30'));
  return { start, end };
}

// ---------------- RAZORPAY APIs ----------------

// 1) Create Razorpay order for payment
app.post('/api/payments/create-order', async (req, res) => {
  try {
    const { amount } = req.body; // in rupees
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const options = {
      amount: Math.round(amount * 100), // rupees -> paise
      currency: 'INR',
      receipt: 'mh_' + Date.now(),
      payment_capture: 1
    };

    const order = await razorpay.orders.create(options);
    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// 2) Verify payment + create restaurant order
app.post('/api/payments/verify-and-create-order', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderPayload
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error('Signature mismatch');
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // payment verified -> create order in DB
    const {
      orderType,
      customerName,
      registrationNumber,
      mobile,
      tableNumber,
      address,
      items
    } = orderPayload || {};

    const total = (items || []).reduce(
      (s, i) => s + (i.price || 0) * (i.qty || 0),
      0
    );

    const order = new Order({
      orderType,
      customerName,
      registrationNumber,
      mobile,
      tableNumber,
      address,
      items,
      total,
      status: 'incoming'
    });

    await order.save();
    io.emit('newOrder', order);

    res.json({
      success: true,
      order,
      razorpay_payment_id,
      razorpay_order_id
    });
  } catch (err) {
    console.error('Error verifying payment / creating order:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------- ORDERS APIs ----------------

// Get orders for a given date (IST)
app.get('/api/orders', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { start, end } = getISTDateBounds(date);
  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  }).sort({ createdAt: -1 });
  res.json(orders);
});

// Place new order (keep this for COD / offline if you want)
app.post('/api/orders', async (req, res) => {
  const {
    orderType,
    customerName,
    registrationNumber,
    mobile,
    tableNumber,
    address,
    items
  } = req.body;

  const total = (items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);

  const order = new Order({
    orderType,
    customerName,
    registrationNumber,
    mobile,
    tableNumber,
    address,
    items,
    total,
    status: 'incoming'
  });

  await order.save();
  io.emit('newOrder', order);
  res.json(order);
});

// Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  const { id }    = req.params;
  const { status } = req.body;

  const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
  if (order) {
    io.emit('orderUpdated', order);
    res.json(order);
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

// ---------------- DASHBOARD APIs ----------------

// Total sales for a day/week/month (IST based)
app.get('/api/dashboard/sales', async (req, res) => {
  const period = req.query.period || 'day';
  const date   = req.query.date   || new Date().toISOString().slice(0, 10);

  let start, end;
  if (period === 'day') {
    ({ start, end } = getISTDateBounds(date));
  } else if (period === 'week') {
    const { start: dayStart } = getISTDateBounds(date);
    const d     = new Date(dayStart);
    const first = new Date(d.setDate(d.getDate() - d.getDay()));
    start = new Date(first.setHours(0, 0, 0, 0));
    end   = new Date(new Date(start).setDate(start.getDate() + 7));
  } else if (period === 'month') {
    const { start: dayStart } = getISTDateBounds(date);
    const d = new Date(dayStart);
    start   = new Date(d.getFullYear(), d.getMonth(), 1);
    end     = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  });
  const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  res.json({ total, count: orders.length });
});

// Peak Hour (IST)
app.get('/api/dashboard/peakhour', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { start, end } = getISTDateBounds(date);

  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  });

  const hourly = {};
  orders.forEach(o => {
    const hour = new Date(o.createdAt).getHours();
    hourly[hour] = (hourly[hour] || 0) + 1;
  });

  let peak = { hour: '-', count: 0 };
  Object.entries(hourly).forEach(([h, c]) => {
    if (c > peak.count) peak = { hour: h, count: c };
  });
  res.json(peak);
});

// Most Ordered Dish (IST)
app.get('/api/dashboard/topdish', async (req, res) => {
  let start, end;
  if (req.query.from && req.query.to) {
    ({ start, end } = getISTDateBounds(req.query.from));
    const toBounds = getISTDateBounds(req.query.to);
    end = toBounds.end;
  } else {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    ({ start, end } = getISTDateBounds(date));
  }

  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  });

  const countMap = {};
  orders.forEach(o => {
    (o.items || []).forEach(i => {
      const n = i.name || 'Unnamed Item';
      countMap[n] = (countMap[n] || 0) + (i.qty || 0);
    });
  });

  const top = Object.entries(countMap).sort((a, b) => b[1] - a[1])[0];
  res.json(top ? { _id: top[0], count: top[1] } : null);
});

// Repeat Customers (IST)
app.get('/api/dashboard/repeatcustomers', async (req, res) => {
  let start, end;
  if (req.query.from && req.query.to) {
    ({ start, end } = getISTDateBounds(req.query.from));
    const toBounds = getISTDateBounds(req.query.to);
    end = toBounds.end;
  } else {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    ({ start, end } = getISTDateBounds(date));
  }

  const nameFilter = req.query.name ? { customerName: req.query.name } : {};
  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' },
    ...nameFilter
  });

  const stats = {};
  orders.forEach(o => {
    if (!o.customerName) return;
    stats[o.customerName] = (stats[o.customerName] || 0) + 1;
  });

  if (req.query.name) {
    return res.json([{ _id: req.query.name, orders: stats[req.query.name] || 0 }]);
  }

  const sorted = Object.entries(stats)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ _id: name, orders: count }));
  res.json(sorted);
});

// ---------------- SOCKET.IO ----------------
io.on('connection', (socket) => {
  console.log('🟢 Military Hotel client connected');
  socket.emit('connected', { status: 'connected' });
});

// ---------------- HEALTH CHECK ----------------
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ---------------- SERVER ----------------
server.listen(PORT, () => {
  console.log(`🚀 Military Hotel Server running on http://localhost:${PORT}`);
});
