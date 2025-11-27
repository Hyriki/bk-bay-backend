const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/auth');

const { 
    createOrder, 
    getOrderDetails, 
    getTopSellingProducts,
    getSellerOrders,
    updateOrderStatus,
    updateOrder,
    deleteOrder,
    claimOrder,
    confirmDelivery
} = require('../controllers/orderController');

// Public routes
router.post('/', verifyToken, createOrder);
router.put('/:orderId', verifyToken, updateOrder);
router.delete('/:orderId', verifyToken, deleteOrder);
router.get('/details', verifyToken, getOrderDetails);
router.get('/reports/top-selling', verifyToken, getTopSellingProducts);
router.get('/seller', verifyToken, getSellerOrders);
router.patch('/:orderId/status', verifyToken, updateOrderStatus);
router.post('/claim/:orderId', verifyToken, claimOrder);
router.post('/confirm/:orderId', verifyToken, confirmDelivery);

module.exports = router;