const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/auth');

const {
    getCategories,
    getProductByName,
    getAllProduct,
    getProductByCategory,
    getProductDetailsController,
} = require('../controllers/productController');

// Public routes
// input: none
// returns list of category names
router.get('/categories', getCategories);
// Search by category: /api/products/categories?category=beverages
router.get('/category/:category', getProductByCategory);

// Search by name: /api/products/search?name=apple
// Returns products name, rating, price, image (can be null)
router.get('/search', getProductByName);

// input: none
// returns all products info
router.get('/all', getAllProduct);

// input: barcode
// returns product details, images, variations, category
router.get('/:barcode', getProductDetailsController);

module.exports = router;