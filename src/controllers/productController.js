const productModel = require('../models/Product');

/**
 * GET /api/products/categories
 */
const getCategories = async (req, res) => {
    try {
        const categories = await productModel.getCategories();
        res.status(200).json({
            success: true,
            categories
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch categories',
            error: err.message
        });
    }
};


/**
 * GET /api/products/search?name=...
 *
 * Returns products whose name contains the given substring.
 */
const getProductByName = async (req, res) => {
    try {
        const name = req.query.name;
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'query parameter "name" is required'
            });
        }

        const products = await productModel.getProductByName(name);

        res.status(200).json({
            success: true,
            products
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Failed to search products by name',
            error: err.message
        });
    }
};

/**
 * GET /api/products/all
 *
 * Returns all products in the database.
 */
const getAllProduct = async (req, res) => {
    try {
        const products = await productModel.getAllProduct();
        res.status(200).json({
            success: true,
            products
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch all products',
            error: err.message
        });
    }
};

/**
 * GET /api/products/:barcode

 *  - recordsets[0] => product row(s)
 *  - recordsets[1] => images
 *  - recordsets[2] => variations
 *  - recordsets[3] => categories
 */
 

const getProductByCategory = async (req, res) => {
    try {
        // accept category from either route param or query string
        const category = req.params.category || req.query.category;
        if (!category) {
            return res.status(400).json({
                success: false,
                message: 'category is required (use /category/:category or ?category=...)'
            });
        }

        const products = await productModel.getProductByCategory(category);

        res.status(200).json({
            success: true,
            products
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products for category',
            error: err.message
        });
    }
};

const getProductDetailsController = async (req, res) => {
    try {
        // 1. Input Extraction and Validation
        // NOTE: Ensure 'barcode' matches the route definition (e.g., router.get('/:barcode', ...))
        const { barcode } = req.params; 

        if (!barcode) {
            return res.status(400).json({
                success: false,
                message: 'Barcode is required'
            });
        }
        
        // 2. Service Call
        // This function handles the DB queries, Promise.all, and data structure.
        const productData = await productModel.getProductDetails(barcode);

        // 3. Handle 404 Not Found
        if (!productData) {
            // The service returns null if the product query yielded no results.
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // 4. Success Response (HTTP 200 OK)
        // Spreading productData sends a flat, clean object to the frontend
        return res.status(200).json({
            success: true,
            ...productData
        });

    } catch (err) {
        // 5. Handle Server/Database Errors (HTTP 500)
        console.error("API Error in getProductDetailsController:", err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch product details due to a server error.',
            error: err.message
        });
    }
};

module.exports = {
    getCategories,
    getProductByCategory,
    getProductByName,
    getAllProduct,
    getProductDetailsController,
};