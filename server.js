const express = require("express");
const mysql = require("mysql");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "padsi",
});

db.connect((err) => {
  if (err) {
    console.error("MySQL connection error:", err);
  } else {
    console.log("Connected to MySQL database");
  }
});

const secretKey = process.env.SECRET_KEY;
const dbConnectionString = process.env.DB_CONNECTION_STRING;

function verifyToken(req, res, next) {
  const token = req.headers["authorization"];

  if (!token) {
    return res.status(403).json({ message: "Token not provided" });
  }

  jwt.verify(token, secretKey, (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: "Invalid token" });
    }
    req.user = decoded;
    next();
  });
}

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const query = "SELECT * FROM users WHERE BINARY username = ? AND BINARY password = ?";

  db.query(query, [username, password], (err, result) => {
    if (err) {
      console.error("MySQL query error:", err);
      res.status(500).json({ message: "Internal server error" });
    } else {
      if (result.length > 0) {
        const user = { username: result[0].username, firstname: result[0].firstname, lastname: result[0].lastname };
        const token = jwt.sign(user, secretKey, { expiresIn: '1h' });

        res.status(200).json({ message: "Login successful", token });
      } else {
        res.status(401).json({ message: "Invalid credentials" });
      }
    }
  });
});

app.get("/protected-route", verifyToken, (req, res) => {
  const { firstname, lastname } = req.user;
  res.json({ message: `Hello, ${firstname} ${lastname}` });
});

app.post("/register", (req, res) => {
  const { firstname, lastname, username, password, confirmPassword, role } =
    req.body;

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match" });
  }

  const userRole = role || "Employee";

  const sql =
    "INSERT INTO users (firstname, lastname, username, password, role) VALUES (?, ?, ?, ?, ?)";
  db.query(
    sql,
    [firstname, lastname, username, password, userRole],
    (err, result) => {
      if (err) {
        console.error("MySQL query error:", err);
        return res.status(500).json({ message: "Internal server error" });
      } else {
        console.log("User registered:", result);
        return res.status(200).json({ message: "Registration successful" });
      }
    }
  );
});

app.get("/transactions", (req, res) => {
  const sql = `
    SELECT
      t.id_transactions,
      t.name AS transaction_name,
      t.name_service AS transaction_name_service,
      t.issued_transactions,
      t.total_transactions,
      c.name AS customer_name,
      c.email AS customer_email,
      c.phone AS customer_phone,
      s.id_service,
      u.firstname AS user_firstname,
      u.lastname AS user_lastname
    FROM transactions t
    LEFT JOIN customers c ON t.id_customers = c.id_customers
    LEFT JOIN services s ON t.name_service = s.name_service
    LEFT JOIN users u ON t.id_users = u.id_users
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res
        .status(500)
        .json({ error: "Internal Server Error", details: err.message });
    } else {
      const transactions = results.map((row) => ({
        id_transactions: row.id_transactions,
        transaction_name: row.transaction_name,
        transaction_name_service: row.transaction_name_service,
        issued_transactions: row.issued_transactions,
        total_transactions: row.total_transactions,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        customer_phone: row.customer_phone,
        id_service: row.id_service,
        user_firstname: row.user_firstname,
        user_lastname: row.user_lastname,
      }));
      console.log("Fetched data:", transactions);
      res.json(transactions);
    }
  });
});

app.post("/add-transaction", (req, res) => {
  const {
    name,
    name_service,
    price_service,
    quantity,
    total_transactions,
    issued_transactions,
    id_customers,
    id_users,
  } = req.body;

  if (
    name &&
    total_transactions &&
    issued_transactions &&
    id_customers &&
    name_service &&
    quantity
  ) {
    const nameServiceValue = Array.isArray(name_service)
      ? name_service.join("\n")
      : name_service;
    const priceServiceValue = Array.isArray(price_service)
      ? price_service.join("\n")
      : price_service;
    const quantityValue = Array.isArray(quantity) ? quantity : [quantity];

    db.beginTransaction((err) => {
      if (err) {
        console.error("Error starting transaction:", err);
        return res.status(500).json({ error: "Internal Server Error", details: err.message });
      }

      const transactionInsertQuery = `
        INSERT INTO transactions (name, name_service, price_service, quantity, total_transactions, issued_transactions, id_customers, id_users)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      db.query(
        transactionInsertQuery,
        [
          name,
          nameServiceValue,
          priceServiceValue,
          quantityValue.join("\n"),
          total_transactions,
          issued_transactions,
          id_customers,
          id_users,
        ],
        (err, result) => {
          if (err) {
            console.error("Error adding transaction:", err);
            return db.rollback(() => {
              res.status(500).json({ error: "Internal Server Error", details: err.message });
            });
          }

          for (let i = 0; i < name_service.length; i++) {
            const serviceName = name_service[i];
            const serviceQuantity = quantity[i];

            const productUpdateQuery = `
              UPDATE Products
              SET quantity_product = quantity_product - ?
              WHERE id_product IN (
                SELECT product_id FROM ServiceProducts WHERE service_id = (
                  SELECT id_service FROM services WHERE name_service = ?
                )
              )
            `;
            db.query(productUpdateQuery, [serviceQuantity, serviceName], (err, updateResult) => {
              if (err) {
                console.error("Error updating product quantity:", err);
                return db.rollback(() => {
                  res.status(500).json({ error: "Internal Server Error", details: err.message });
                });
              }
            });
          }

          db.commit((err) => {
            if (err) {
              console.error("Error committing transaction:", err);
              return db.rollback(() => {
                res.status(500).json({ error: "Internal Server Error", details: err.message });
              });
            }
            res.status(200).json({ message: "Transaction added successfully" });
          });
        }
      );
    });
  } else {
    res.status(400).json({ error: "Missing required fields" });
  }
});

app.get("/transactions/details/:id", (req, res) => {
  const id = parseInt(req.params.id);

  db.query(
    "SELECT t.id_transactions, t.name, t.name_service, t.price_service, t.quantity, t.issued_transactions, t.total_transactions, t.id_customers, t.id_users, " +
      "c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, " +
      "s.name_service AS service_name, " +
      "u.firstname AS user_firstname, u.lastname AS user_lastname " +
      "FROM transactions t " +
      "JOIN customers c ON t.id_customers = c.id_customers " +
      "LEFT JOIN services s ON t.name_service = s.name_service " +
      "LEFT JOIN users u ON t.id_users = u.id_users " +
      "WHERE t.id_transactions = ?",
    [id],
    (queryError, results) => {
      if (queryError) {
        console.error("Error fetching transaction details:", queryError);
        res.status(500).json({
          error: "Internal server error",
          details: queryError.message,
        });
      } else if (results.length > 0) {
        res.json(results[0]);
      } else {
        console.error("Transaction not found for id: ", id);
        res.status(404).json({ error: "Transaction not found" });
      }
    }
  );
});

app.put("/edit-transaction/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const {
    name,
    name_service,
    price_service,
    quantity,
    total_transactions,
    issued_transactions,
    id_customers,
    id_users,
  } = req.body;

  if (
    name &&
    total_transactions &&
    issued_transactions &&
    id_customers &&
    name_service
  ) {
    const nameServiceValue = Array.isArray(name_service)
      ? name_service.join("\n")
      : name_service;
    const priceServiceValue = Array.isArray(price_service)
      ? price_service.join("\n")
      : price_service;
    const quantityValue = Array.isArray(quantity)
      ? quantity.join("\n")
      : quantity;

    const sql = `
      UPDATE transactions 
      SET 
        name = ?,
        name_service = ?,
        price_service = ?,
        quantity = ?,
        total_transactions = ?,
        issued_transactions = ?,
        id_customers = ?,
        id_users = ?
      WHERE id_transactions = ?
    `;

    db.query(
      sql,
      [
        name,
        nameServiceValue,
        priceServiceValue,
        quantityValue,
        total_transactions,
        issued_transactions,
        id_customers,
        id_users,
        id,
      ],
      (err, result) => {
        if (err) {
          console.error("Error editing transaction:", err);
          res
            .status(500)
            .json({ error: "Internal Server Error", details: err.message });
        } else if (result.affectedRows > 0) {
          res.status(200).json({ message: "Transaction updated successfully" });
        } else {
          res.status(404).json({ error: "Transaction not found" });
        }
      }
    );
  } else {
    res.status(400).json({ error: "Missing required fields" });
  }
});

app.delete("/delete-transaction/:id", (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM transactions WHERE id_transactions = ?";
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting transaction:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Transaction deleted successfully" });
      } else {
        res.status(404).json({ error: "Transaction not found" });
      }
    }
  });
});

app.get("/customers", (req, res) => {
  const sql = "SELECT id_customers, name, email, phone FROM customers";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      res.json(results);
    }
  });
});

app.post("/add-customer", (req, res) => {
  const { name, email, phone } = req.body;

  const sql = "INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)";
  db.query(sql, [name, email, phone], (err, result) => {
    if (err) {
      console.error("Error adding customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      res.status(200).json({ message: "Customer added successfully" });
    }
  });
});

app.put("/update-customer/:id", (req, res) => {
  const { id } = req.params;
  const { name, email, phone } = req.body;

  const sql =
    "UPDATE customers SET name = ?, email = ?, phone = ? WHERE id_customers = ?";
  db.query(sql, [name, email, phone, id], (err, result) => {
    if (err) {
      console.error("Error updating customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer updated successfully" });
      } else {
        res.status(404).json({ error: "Customer not found" });
      }
    }
  });
});

app.delete("/delete-customer/:id", (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM customers WHERE id_transactions = ?";
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer deleted successfully" });
      } else {
        res.status(404).json({ error: "Customer not found" });
      }
    }
  });
});

app.get("/users", (req, res) => {
  const sql =
    "SELECT id_users, firstname, lastname, username, password, role FROM users";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      res.json(results);
    }
  });
});

app.post("/add-user", (req, res) => {
  const { firstname, lastname, username, password, role } = req.body;

  const userRole = role || "Employee";

  const sql =
    "INSERT INTO users (firstname, lastname, username, password, role) VALUES (?, ?, ?, ?, ?)";
  db.query(
    sql,
    [firstname, lastname, username, password, userRole],
    (err, result) => {
      if (err) {
        console.error("Error adding customer:", err);
        res.status(500).json({ error: "Internal Server Error" });
      } else {
        res.status(200).json({ message: "Customer added successfully" });
      }
    }
  );
});

app.put("/update-user/:id", (req, res) => {
  const { id } = req.params;
  const { firstname, lastname, username, role } = req.body;

  const sql =
    "UPDATE users SET firstname = ?, lastname = ?, username = ?, role = ? WHERE id_users = ?";
  db.query(sql, [firstname, lastname, username, role, id], (err, result) => {
    if (err) {
      console.error("Error updating customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer updated successfully" });
      } else {
        res.status(404).json({ error: "Customer not found" });
      }
    }
  });
});

app.delete("/delete-user/:id", (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM users WHERE id_users = ?";
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer deleted successfully" });
      } else {
        res.status(404).json({ error: "Customer not found" });
      }
    }
  });
});

app.get("/products", (req, res) => {
  const sql = "SELECT * FROM products";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      res.json(results);
    }
  });
});

app.put("/update-products/:id", (req, res) => {
  const { id } = req.params;
  const { name_product, quantity_product } = req.body;

  const sql =
    "UPDATE products SET name_product = ?, quantity_product = ? WHERE id_product = ?";
  db.query(sql, [name_product, quantity_product, id], (err, result) => {
    if (err) {
      console.error("Error updating customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer updated successfully" });
      } else {
        res.status(404).json({ error: "Customer not found" });
      }
    }
  });
});

app.get("/services-with-products", (req, res) => {
  const query = `
  SELECT
    s.id_service,
    s.name_service,
    CASE
        WHEN SUM(CASE WHEN p.quantity_product = 0 THEN 1 ELSE 0 END) > 0 THEN 'No'
        ELSE 'Yes'
    END AS availability
  FROM
    services s
  LEFT JOIN
    serviceproducts ps ON s.id_service = ps.service_id
  LEFT JOIN
    products p ON ps.product_id = p.id_product
  GROUP BY
    s.id_service, s.name_service;
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error(err);
      res.status(500).send("Server Error");
      return;
    }
    res.json(results);
  });
});

app.get("/services", (req, res) => {
  const sql = "SELECT * FROM services";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      res.json(results);
    }
  });
});
