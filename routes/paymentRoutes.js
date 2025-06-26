const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
};

router.post('/buy-chips', authenticate, async (req, res) => {
    const { nonce, amount } = req.body;

    const client = req.app.locals.squareClient;
    const paymentsApi = client.paymentsApi;

    try {
        const response = await paymentsApi.createPayment({
            sourceId: nonce,
            amountMoney: {
                amount: amount,
                currency: 'USD',
            },
            idempotencyKey: new Date().getTime().toString(),
        });

        const user = await User.findById(req.userId);
        user.chips += amount / 100;
        await user.save();

        res.json({ success: true, payment: response.result.payment, chips: user.chips });
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

module.exports = router;
