const pool = require('../config/database');
const sql = require('mssql');

const getCartIdByUserId = async (userId) => {
    const req = pool.request();
    req.input('UserID', sql.VarChar, userId);
    const result = await req.query('SELECT cartId FROM Buyer WHERE Id = @UserID');
    if (result.recordset && result.recordset[0]) {
        return result.recordset[0].cartId;
    }
    return null;
}

const getCartItems = async (cartId) => {
    const request = pool.request();
    request.input('CartID', sql.VarChar, cartId);

    // Explicit SQL Query to join Cart_Item, Product, Variation, and Images
    // We use OUTER APPLY to fetch just one image per product safely
    const query = `
        SELECT 
            CI.Barcode,
            CI.Variation_Name,
            CI.Quantity,
            P.Name AS Product_Name,
            V.PRICE,
            V.STOCK,
            IMG.IMAGE_URL
        FROM Cart_Item CI
        INNER JOIN Product_SKU P ON CI.Barcode = P.Bar_code
        INNER JOIN VARIATIONS V ON CI.Barcode = V.Bar_code AND CI.Variation_Name = V.NAME
        OUTER APPLY (
            SELECT TOP 1 IMAGE_URL 
            FROM IMAGES I 
            WHERE I.Bar_code = CI.Barcode
        ) IMG
        WHERE CI.Cart_ID = @CartID
    `;

    const result = await request.query(query);
    const rows = result.recordset || [];

    // --- KEY FIX: Map SQL columns to Frontend (CamelCase) structure ---
    return rows.map(row => ({
        // Create a unique ID for React keys
        id: `${row.Barcode}-${row.Variation_Name}`,
        
        barcode: row.Barcode,
        name: row.Product_Name, // Maps 'Product_Name' to 'name'
        
        // Map Variation_Name to 'color' so it shows up in the UI
        color: row.Variation_Name, 
        size: '', // Optional: leave empty if not stored separately
        
        // Fixes the $NaN error
        price: row.PRICE || 0, 
        
        quantity: row.Quantity,
        
        // Fixes the empty image
        imageUrl: row.IMAGE_URL || null, 
        
        stockCount: row.STOCK,
        stockStatus: (row.STOCK > 0) ? 'in' : 'out'
    }));
};

const addVariationToCart = async (cartId, barcode, variationName, quantity) => {
    const req = pool.request();
    req.input('CartID', sql.VarChar, cartId);
    req.input('BarCode', sql.VarChar, barcode);
    req.input('VariationName', sql.VarChar, variationName);
    req.input('Quantity', sql.Int, quantity);
    await req.execute('addVariationToCart');
}

const deleteCartItem = async (cartId, barcode, variationName) => {
    const req = pool.request();
    req.input('CartID', sql.VarChar, cartId);
    req.input('BarCode', sql.VarChar, barcode);
    req.input('VariationName', sql.VarChar, variationName);
    await req.execute('deleteCartItem');
}

module.exports = {
    getCartIdByUserId,
    getCartItems,
    addVariationToCart,
    deleteCartItem
};