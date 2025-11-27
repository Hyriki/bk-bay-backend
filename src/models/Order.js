// src/models/Order.js
const pool = require('../config/database');
const sql = require('mssql');
const { generateId } = require('../utils/userUtils');

async function getTotalByOrderId(orderId) {
    const request = pool.request();
    request.input('orderId', sql.VarChar, orderId);
    
    // Truy vấn cột Total đã được cập nhật
    const result = await request.query('SELECT Total FROM [Order] WHERE ID = @orderId'); 
    
    // Trả về giá trị Total (hoặc 0 nếu lỗi)
    return result.recordset[0]?.Total || 0;
}

async function getOrderById(orderId, buyerId) {
    const request = pool.request();
    request.input('orderId', sql.VarChar, orderId);
    request.input('buyerId', sql.VarChar, buyerId);
    const result = await request.query('SELECT ID, Total, [Address], buyerID, [Time], [Status] FROM [Order] WHERE ID = @orderId AND buyerID = @buyerId');
    const order = result.recordset[0];
    if (!order) return null;

    try {
        const oiReq = pool.request();
        oiReq.input('orderId', sql.VarChar, orderId);
        const oiRes = await oiReq.query(`
            SELECT ID AS orderItemID, Quantity, Price, BarCode, Variation_Name FROM Order_Item WHERE orderID = @orderId
        `);
        order.orderItems = oiRes.recordset || [];
    } catch (e) {
        order.orderItems = [];
    }
    return order;
}

const createOrder = async ({buyerId, total, address, status, quantity, price, barcode, variationname }) => {
    // 1. Create a transaction using the existing pool
    console.log("Data received for createOrder:", { buyerId, address, status, quantity, price, barcode, variationname });
    const transaction = new sql.Transaction(pool);

    try {
        // Start Transaction
        await transaction.begin();

        // Use the provided id (from controller) when available so tokens match DB id.
        // If no id provided, generate one.
        const orderId = generateId();
        const itemIdentifier = generateId();

        // 2. Insert into "Order" Table
        const oreq = new sql.Request(transaction);
        // Match column sizes: ID(100), Address(255), Status(100), buyerID(100)
        oreq.input('id', sql.VarChar(100), orderId);
        oreq.input('address', sql.VarChar(255), address);
        oreq.input('status', sql.VarChar(100), status);
        oreq.input('buyerId', sql.VarChar(100), buyerId);
        await oreq.query(`
            INSERT INTO [Order] (ID, Total, [Address], buyerID, [Time], [Status])
            VALUES (@id, 0, @address, @buyerId, GETDATE(), @status)
        `);

        if (!barcode || !variationname) {
            // Do not rollback here; let the catch block perform a single rollback.
            throw new Error('barcode and variationname are required to link (Order_Item)');
        }

        const oitemreq = new sql.Request(transaction);
        // Match Order_Item schema: Price DECIMAL(10,2), BarCode VARCHAR(100), Variation_Name VARCHAR(100), ID VARCHAR(100), orderID VARCHAR(100)
        oitemreq.input('price', sql.Decimal(10, 2), price);
        oitemreq.input('barcode', sql.VarChar(100), barcode);
        oitemreq.input('variation_name', sql.VarChar(100), variationname);
        oitemreq.input('quantity', sql.Int, quantity);
        oitemreq.input('id', sql.VarChar(100), itemIdentifier);
        oitemreq.input('orderId', sql.VarChar(100), orderId);
        await oitemreq.query(`
            INSERT INTO Order_Item (Price, BarCode, Variation_Name, Quantity, ID, orderID) 
            VALUES (@price, @barcode, @variation_name, @quantity, @id, @orderId)
        `);

        // 4. Update Order.Total = SUM(Order_Item.Price * Quantity) for this order
        const totalReq = new sql.Request(transaction);
        totalReq.input('orderId', sql.VarChar, orderId);
        await totalReq.query(`
            UPDATE [Order]
            SET Total = (
                SELECT COALESCE(SUM(oi.Price * oi.Quantity), 0)
                FROM Order_Item oi
                WHERE oi.orderID = @orderId
            )
            WHERE ID = @orderId;
        `);

        // 5. Commit Transaction (Save everything)
        await transaction.commit();

        const finalTotal = await getTotalByOrderId(orderId);

        return { 
            id: orderId, 
            total: finalTotal, 
            address: address, 
            status: status,
            buyerId: buyerId,
            orderItemId: itemIdentifier,
            quantity: quantity,
            price: price,
            barcode: barcode,
            variationname: variationname,
        };

    } catch (err) {
        try {
            await transaction.rollback();
        } catch (rbErr) {
            // Suppress double-rollback EABORT noise; keep original error.
            if (process.env.NODE_ENV !== 'production') {
                console.warn('Rollback warning (ignored):', rbErr.message);
            }
        }
        throw err;
    }
};

async function updateOrder({ orderId, newStatus, newAddress }) {
    const transaction = new sql.Transaction(pool); 
    
    try {
        await transaction.begin();
        
        const request = new sql.Request(transaction);
        
        request.input('p_OrderID', sql.VarChar, orderId);
        request.input('p_NewStatus', sql.VarChar, newStatus || null);
        request.input('p_NewAddress', sql.VarChar, newAddress || null);

        await request.query(`
            UPDATE [Order] 
            SET 
                [Status] = COALESCE(@p_NewStatus, [Status]),
                Address = COALESCE(@p_NewAddress, Address)
            WHERE ID = @p_OrderID;
        `);

        await transaction.commit();

        return { success: true, orderId, updatedStatus: newStatus, updatedAddress: newAddress };
        
    } catch (e) {
        await transaction.rollback();
        throw e;
    }
}

async function deleteOrder({ orderId, userId }) {
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        // 1. Kiểm tra Status và Quyền (SELECT DỮ LIỆU TRƯỚC KHI XÓA)
        const checkReq = new sql.Request(transaction);
        checkReq.input('p_OrderID', sql.VarChar, orderId);
        checkReq.input('p_UserID', sql.VarChar, userId);
        const checkResult = await checkReq.query(`
            SELECT [Status], buyerID FROM [Order] WHERE ID = @p_OrderID;
        `);
        
        const order = checkResult.recordset[0];
        if (!order) {
            await transaction.rollback();
            throw new Error('Order not found.');
        }

        if (order.Status !== 'Pending' && order.Status !== 'Processing') {
            await transaction.rollback();
            throw new Error('Cannot delete/cancel an order that is in transit or delivered.');
        }
        
        // 2. Thực hiện xóa DML SQL thuần
        const deleteReq = new sql.Request(transaction);
        deleteReq.input('p_OrderID', sql.VarChar, orderId);
        await deleteReq.query(`DELETE FROM [Order] WHERE ID = @p_OrderID AND buyerID = @p_UserID;`);
        
        // 3. Commit Transaction
        await transaction.commit();
        
        return { orderId, deleted: true };
        
    } catch (e) {
        await transaction.rollback();
        throw e;
    }
}

// 1. Hàm gọi usp_GetOrderDetails (Mục 2.3 - Query 1)
// src/models/Order.js (Hàm getOrderDetails đã cải tiến)

async function getOrderDetails(statusFilter, minItems) {    
    // Force use fallback query instead of SP to get full user details
    // Uncomment below to try SP first
    /*
    try {
        const request = pool.request();
        request.input('p_StatusFilter', sql.VarChar, statusFilter);
        request.input('p_MinItems', sql.Int, parseInt(minItems, 10) || 0);
        result = await request.execute('usp_GetOrderDetails');
        return result.recordset;
    } catch (e) {
        console.warn(`WARN: Failed to execute usp_GetOrderDetails. Falling back to SQL query. Error: ${e.message}`);
    }
    */
    
    // Direct SQL query with full user details
    try {
        const fallbackReq = pool.request();
        fallbackReq.input('p_StatusFilter', sql.VarChar, statusFilter);

            const fallbackQuery = `
                SELECT 
                    O.ID, 
                    O.[Status], 
                    O.Total, 
                    O.[Address],
                    O.[Time],
                    O.buyerID,
                    U.Username,
                    U.Email,
                    U.Gender,
                    U.Age,
                    U.DateOfBirth,
                    U.[Address] AS UserAddress,
                    U.[Rank]
                FROM [Order] O 
                INNER JOIN [User] U ON O.buyerID = U.Id
                WHERE (@p_StatusFilter IS NULL OR O.[Status] = @p_StatusFilter)
                ORDER BY O.[Time] DESC;
            `;
            
            const fallbackRes = await fallbackReq.query(fallbackQuery);
            return fallbackRes.recordset;

    } catch (fallbackError) {
        // Nếu cả cơ chế dự phòng cũng thất bại (Ví dụ: lỗi kết nối)
        console.error('FATAL FALLBACK ERROR:', fallbackError.message);
        throw fallbackError;
    }
}

// 2. Hàm gọi usp_GetTopSellingProducts (Mục 2.3 - Query 2)
async function getTopSellingProducts(minQuantity, sellerId) {
    try {
        const request = pool.request();
        request.input('p_MinQuantitySold', sql.Int, parseInt(minQuantity, 10) || 0);
        request.input('p_SellerID', sql.VarChar, sellerId || null); 

        const result = await request.execute('usp_GetTopSellingProducts');
        
        // 3. Trả về tập kết quả
        return result.recordset || [];

    } catch (e) {
        console.warn(`WARN: Failed to execute usp_GetTopSellingProducts. Falling back to simple SQL query. Error: ${e.message}`);
        
        try {
            const fallbackReq = pool.request();
            fallbackReq.input('p_SellerID', sql.VarChar, sellerId || null);
            const fallbackQuery = `
                SELECT 
                    PS.Bar_code,
                    PS.[Name],
                    SUM(OI.Quantity) AS TotalQuantitySold
                FROM Order_Item OI
                INNER JOIN [Order] O ON OI.OrderID = O.ID
                INNER JOIN Product_SKU PS ON OI.BarCode = PS.Bar_code
                WHERE
                    O.[Status] IN ('Delivered', 'Completed')
                    AND (@p_SellerID IS NULL OR PS.sellerID = @p_SellerID) 
                GROUP BY
                    PS.Bar_code, PS.[Name]
                ORDER BY
                    TotalQuantitySold DESC;
            `;
            
            const fallbackRes = await fallbackReq.query(fallbackQuery);
            
            return fallbackRes.recordset || [];

        } catch (fallbackError) {
            console.error('FATAL FALLBACK ERROR IN GET TOP PRODUCTS:', fallbackError.message);
            throw fallbackError;
        }
    }
}

async function claimOrder({ orderId, shipperId }) {
    const transaction = new sql.Transaction(pool);
    
    try {
        await transaction.begin(); 
        
        const request = new sql.Request(transaction); 
        
        request.input('p_OrderID', sql.VarChar, orderId);
        request.input('p_ShipperID', sql.VarChar, shipperId);
        
        // T-SQL TRANSACTION DML: Claim Order
        const claimQuery = `
            DECLARE @v_CurrentStatus VARCHAR(100);
            
            -- 1. Kiểm tra trạng thái hiện tại (Validation: Phải ở Processing)
            SELECT @v_CurrentStatus = [Status] FROM [Order] WHERE ID = @p_OrderID;

            IF @v_CurrentStatus IS NULL
            BEGIN
                THROW 50005, 'Order not found.', 1;
                RETURN;
            END

            IF @v_CurrentStatus <> 'Processing'
            BEGIN
                THROW 50006, 'Order status must be "Processing" to be claimed.', 1;
                RETURN;
            END

            -- 2. INSERT vào bảng Deliver (Claim the Order)
            INSERT INTO Deliver (ShipperID, OrderID, Departure_time, Finish_time, ShippingFee)
            VALUES (@p_ShipperID, @p_OrderID, NULL, NULL, NULL); 

            -- 3. UPDATE trạng thái Order: Processing -> Dispatched
            UPDATE [Order] 
            SET [Status] = 'Dispatched' 
            WHERE ID = @p_OrderID;
            
            -- Trả về trạng thái mới
            SELECT 'Dispatched' AS NewStatus;
        `;

        const result = await request.query(claimQuery);

        await transaction.commit(); 
        
        return { 
            success: true, 
            newStatus: result.recordset[0]?.NewStatus || 'Dispatched',
            orderId: orderId
        };
        
    } catch (e) {
        await transaction.rollback(); 
        throw e;
    }
}

// src/models/Order.js (confirmDelivery)

async function confirmDelivery({ orderId, shipperId }) {
    const transaction = new sql.Transaction(pool);
    
    try {
        await transaction.begin(); 
        
        const request = new sql.Request(transaction);
        request.input('p_OrderID', sql.VarChar, orderId);
        request.input('p_ShipperID', sql.VarChar, shipperId);

        // T-SQL TRANSACTION DML: Confirm Delivery
        const confirmQuery = `
            DECLARE @v_CurrentStatus VARCHAR(100);
            
            -- 1. Kiểm tra trạng thái hiện tại (Validation: Phải ở Delivering)
            SELECT @v_CurrentStatus = [Status] FROM [Order] WHERE ID = @p_OrderID;

            IF @v_CurrentStatus <> 'Delivering'
            BEGIN
                THROW 50007, 'Order must be in "Delivering" status to be confirmed as delivered.', 1;
                RETURN;
            END
            
            -- 2. UPDATE bảng Deliver: Ghi nhận Finish_time
            UPDATE Deliver
            SET Finish_time = GETDATE()
            WHERE OrderID = @p_OrderID AND ShipperID = @p_ShipperID;

            -- 3. UPDATE trạng thái Order: Delivering -> Delivered
            UPDATE [Order] 
            SET [Status] = 'Delivered' 
            WHERE ID = @p_OrderID;
            
            -- Trả về trạng thái mới
            SELECT 'Delivered' AS NewStatus;
        `;

        const result = await request.query(confirmQuery);

        await transaction.commit();
        
        return { 
            success: true, 
            newStatus: result.recordset[0]?.NewStatus || 'Delivered',
            orderId: orderId
        };
        
    } catch (e) {
        await transaction.rollback();
        throw e;
    }
}

async function getOrdersByBuyer(buyerId) {
    try {
        const request = pool.request();
        request.input('p_BuyerID', sql.VarChar(100), buyerId);

        const query = `
            SELECT 
                O.ID,
                O.[Status],
                O.Total,
                O.[Address],
                O.[Time],
                O.buyerID
            FROM [Order] O
            WHERE O.buyerID = @p_BuyerID
            ORDER BY O.[Time] DESC;
        `;

        const result = await request.query(query);
        return result.recordset;

    } catch (e) {
        console.error('Error fetching orders by buyer:', e.message);
        throw e;
    }
}

/**
 * Get orders for a specific seller (orders containing the seller's products)
 * @param {string} sellerId - The seller's ID
 * @param {object} options - Filter options (statusFilter, limit, offset, search)
 * @returns {Promise<Array>} Array of orders with details
 */
async function getSellerOrders(sellerId, options = {}) {
    try {
        const { statusFilter, limit = 20, offset = 0, search } = options;
        const request = pool.request();
        
        request.input('sellerId', sql.VarChar, sellerId);
        request.input('limit', sql.Int, limit);
        request.input('offset', sql.Int, offset);
        
        let whereClause = '';
        if (statusFilter) {
            request.input('statusFilter', sql.VarChar, statusFilter);
            whereClause += ' AND o.[Status] = @statusFilter';
        }
        
        if (search) {
            request.input('search', sql.VarChar, `%${search}%`);
            whereClause += ' AND (o.ID LIKE @search OR u.FullName LIKE @search)';
        }
        
        const query = `
            SELECT DISTINCT
                o.ID,
                o.[Status],
                o.Total,
                o.[Address],
                o.[Time],
                o.buyerID,
                COALESCE(u.FullName, u.Username, 'N/A') AS BuyerName,
                u.Email AS BuyerEmail,
                (
                    SELECT COUNT(*)
                    FROM Order_Item oi2
                    WHERE oi2.orderID = o.ID
                ) AS ItemCount,
                (
                    SELECT STRING_AGG(CONCAT(p.Name, ' (', oi3.Variation_Name, ')'), ', ')
                    FROM Order_Item oi3
                    INNER JOIN Product_SKU p ON oi3.BarCode = p.Bar_code
                    WHERE oi3.orderID = o.ID
                ) AS ProductNames
            FROM [Order] o
            INNER JOIN Order_Item oi ON o.ID = oi.orderID
            INNER JOIN Product_SKU ps ON oi.BarCode = ps.Bar_code
            INNER JOIN [User] u ON o.buyerID = u.Id
            WHERE ps.sellerID = @sellerId ${whereClause}
            ORDER BY o.[Time] DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;
        `;
        
        const result = await request.query(query);
        return result.recordset || [];
    } catch (err) {
        console.error('GET SELLER ORDERS ERROR:', err.message);
        throw err;
    }
}

/**
 * Update order status
 * @param {string} orderId - The order ID
 * @param {string} status - New status
 * @param {string} userId - User making the update
 * @param {string} role - User role (seller/admin)
 * @returns {Promise<object>} Updated order
 */
async function updateOrderStatus(orderId, status, userId, role) {
    try {
        const request = pool.request();
        
        // If seller, verify they own products in this order
        if (role === 'seller') {
            request.input('sellerId', sql.VarChar, userId);
            request.input('orderId', sql.VarChar, orderId);
            
            const checkQuery = `
                SELECT COUNT(*) as count
                FROM Order_Item oi
                INNER JOIN Product_SKU ps ON oi.BarCode = ps.Bar_code
                WHERE oi.orderID = @orderId AND ps.sellerID = @sellerId;
            `;
            
            const checkResult = await request.query(checkQuery);
            if (!checkResult.recordset[0]?.count || checkResult.recordset[0].count === 0) {
                throw new Error('Order not found or seller not authorized to update this order');
            }
        }
        
        // If shipper, verify they claimed this order
        if (role === 'shipper') {
            request.input('shipperId', sql.VarChar, userId);
            request.input('orderId', sql.VarChar, orderId);
            
            const checkQuery = `
                SELECT COUNT(*) as count
                FROM [Order]
                WHERE ID = @orderId AND shipperID = @shipperId;
            `;
            
            const checkResult = await request.query(checkQuery);
            if (!checkResult.recordset[0]?.count || checkResult.recordset[0].count === 0) {
                throw new Error('Order not found or shipper not authorized to update this order');
            }
        }
        
        // Update the order status
        const updateRequest = pool.request();
        updateRequest.input('orderId', sql.VarChar, orderId);
        updateRequest.input('status', sql.VarChar, status);
        
        const updateQuery = `
            UPDATE [Order]
            SET [Status] = @status
            WHERE ID = @orderId;
            
            SELECT 
                o.ID,
                o.[Status],
                o.Total,
                o.[Address],
                o.[Time],
                o.buyerID
            FROM [Order] o
            WHERE o.ID = @orderId;
        `;
        
        const result = await updateRequest.query(updateQuery);
        
        if (!result.recordset || result.recordset.length === 0) {
            throw new Error('Order not found');
        }
        
        return result.recordset[0];
    } catch (err) {
        console.error('UPDATE ORDER STATUS ERROR:', err.message);
        throw err;
    }
}


module.exports = {
    getTotalByOrderId,
    getOrderById,
    createOrder,
    updateOrder,
    deleteOrder,
    getOrderDetails,
    getTopSellingProducts,
    getSellerOrders,
    updateOrderStatus,
    claimOrder,
    confirmDelivery,
    getOrdersByBuyer
};