const express = require("express")
const mysql = require("mysql")
const cors = require("cors")
const bodyParser = require("body-parser")
const jwt = require("jsonwebtoken")
require("dotenv").config()

const app = express()
const PORT = 5000

app.use(cors())
app.use(bodyParser.json())

const db = mysql.createConnection({
  host: process.env.DB_CONNECTION_STRING,
  user: process.env.DB_USER, 
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE, 
});

const secretKey = process.env.SECRET_KEY

db.connect((err) => {
  if (err) {
    console.error("MySQL connection error:", err)
  } else {
    console.log("Connected to MySQL database")
  }
})

app.get("/", (req, res) => {
  res.send("Server is running!")
})

function verifyToken(req, res, next) {
  const token = req.headers["authorization"]

  if (!token) {
    return res.status(403).json({ message: "Token not provided" })
  }

  jwt.verify(token, secretKey, (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: "Invalid token" })
    }
    req.user = decoded
    next()
  })
}

app.get("/protected-route", verifyToken, (req, res) => {
  const { firstname, lastname } = req.user
  res.json({ message: `Hello, ${firstname} ${lastname}` })
})

app.post("/login", (req, res) => {
  const { username, password } = req.body

  const query =
    "SELECT * FROM users WHERE BINARY username = ? AND BINARY password = ?"

  db.query(query, [username, password], (err, result) => {
    if (err) {
      console.error("MySQL query error:", err)
      res.status(500).json({ message: "Internal server error" })
    } else {
      if (result.length > 0) {
        const user = {
          username: result[0].username,
          firstname: result[0].firstname,
          lastname: result[0].lastname,
        }
        const token = jwt.sign(user, secretKey, { expiresIn: "24h" })

        res.status(200).json({ message: "Login successful", token })
      } else {
        res.status(401).json({ message: "Invalid credentials" })
      }
    }
  })
})

app.post("/register", (req, res) => {
  const { firstname, lastname, username, password, confirmPassword, role } =
    req.body

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match" })
  }

  const userRole = role || "Employee"

  const sql =
    "INSERT INTO users (firstname, lastname, username, password, role) VALUES (?, ?, ?, ?, ?)"
  db.query(
    sql,
    [firstname, lastname, username, password, userRole],
    (err, result) => {
      if (err) {
        console.error("MySQL query error:", err)
        return res.status(500).json({ message: "Internal server error" })
      } else {
        console.log("User registered:", result)
        return res.status(200).json({ message: "Registration successful" })
      }
    }
  )
})

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
  `

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err)
      res
        .status(500)
        .json({ error: "Internal Server Error", details: err.message })
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
      }))
      console.log("Fetched data:", transactions)
      res.json(transactions)
    }
  })
})

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
  } = req.body

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
      : name_service
    const priceServiceValue = Array.isArray(price_service)
      ? price_service.join("\n")
      : price_service
    const quantityValue = Array.isArray(quantity) ? quantity : [quantity]

    if (quantityValue.some((qty) => qty <= 0)) {
      return res.status(400).json({ error: "Quantity must be greater than 0" })
    }

    db.beginTransaction((err) => {
      if (err) {
        console.error("Error starting transaction:", err)
        return res
          .status(500)
          .json({ error: "Internal Server Error", details: err.message })
      }

      const checkProductQuery = `
        SELECT p.quantity_product
        FROM Products p
        JOIN ServiceProducts sp ON p.id_product = sp.product_id
        JOIN services s ON sp.service_id = s.id_service
        WHERE s.name_service = ?
      `

      Promise.all(
        name_service.map((serviceName) => {
          return new Promise((resolve, reject) => {
            db.query(checkProductQuery, [serviceName], (err, productResult) => {
              if (err) {
                reject(err)
              } else {
                const productQuantity = productResult[0].quantity_product
                resolve(productQuantity)
              }
            })
          })
        })
      )
        .then((productQuantities) => {
          if (productQuantities.some((qty) => qty <= 0)) {
            return db.rollback(() => {
              res.status(400).json({
                error: "Please contact Admin to update product stock.",
              })
            })
          }

          const transactionInsertQuery = `
            INSERT INTO transactions (name, name_service, price_service, quantity, total_transactions, issued_transactions, id_customers, id_users)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `
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
                console.error("Error adding transaction:", err)
                return db.rollback(() => {
                  res.status(500).json({
                    error: "Internal Server Error",
                    details: err.message,
                  })
                })
              }

              for (let i = 0; i < name_service.length; i++) {
                const serviceName = name_service[i]
                const serviceQuantity = quantity[i]

                const productUpdateQuery = `
                  UPDATE Products
                  SET quantity_product = CASE
                    WHEN quantity_product - ? < -1 THEN -1  -- Set it to -1 to avoid going below -1
                    ELSE quantity_product - ?
                    END
                  WHERE id_product IN (
                    SELECT product_id FROM ServiceProducts WHERE service_id = (
                      SELECT id_service FROM services WHERE name_service = ?
                    )
                  )
                `
                db.query(
                  productUpdateQuery,
                  [serviceQuantity, serviceQuantity, serviceName],
                  (err, updateResult) => {
                    if (err) {
                      console.error("Error updating product quantity:", err)
                      return db.rollback(() => {
                        res.status(500).json({
                          error: "Internal Server Error",
                          details: err.message,
                        })
                      })
                    }
                  }
                )
              }

              db.commit((err) => {
                if (err) {
                  console.error("Error committing transaction:", err)
                  return db.rollback(() => {
                    res.status(500).json({
                      error: "Internal Server Error",
                      details: err.message,
                    })
                  })
                }
                res
                  .status(200)
                  .json({ message: "Transaction added successfully" })
              })
            }
          )
        })
        .catch((err) => {
          console.error("Error checking product quantity:", err)
          return db.rollback(() => {
            res
              .status(500)
              .json({ error: "Internal Server Error", details: err.message })
          })
        })
    })
  } else {
    res.status(400).json({ error: "Missing required fields" })
  }
})

app.get("/transactions/details/:id", (req, res) => {
  const id = parseInt(req.params.id)

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
        console.error("Error fetching transaction details:", queryError)
        res.status(500).json({
          error: "Internal server error",
          details: queryError.message,
        })
      } else if (results.length > 0) {
        res.json(results[0])
      } else {
        console.error("Transaction not found for id: ", id)
        res.status(404).json({ error: "Transaction not found" })
      }
    }
  )
})

app.put("/edit-transaction/:id", (req, res) => {
  const id = parseInt(req.params.id)
  const {
    name,
    name_service,
    price_service,
    quantity,
    total_transactions,
    issued_transactions,
    id_customers,
    id_users,
  } = req.body

  if (
    name &&
    total_transactions &&
    issued_transactions &&
    id_customers &&
    name_service
  ) {
    const nameServiceValue = Array.isArray(name_service)
      ? name_service.join("\n")
      : name_service
    const priceServiceValue = Array.isArray(price_service)
      ? price_service.join("\n")
      : price_service
    const quantityValue = Array.isArray(quantity)
      ? quantity.join("\n")
      : quantity

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
    `

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
          console.error("Error editing transaction:", err)
          res
            .status(500)
            .json({ error: "Internal Server Error", details: err.message })
        } else if (result.affectedRows > 0) {
          res.status(200).json({ message: "Transaction updated successfully" })
        } else {
          res.status(404).json({ error: "Transaction not found" })
        }
      }
    )
  } else {
    res.status(400).json({ error: "Missing required fields" })
  }
})

app.delete("/delete-transaction/:id", (req, res) => {
  const { id } = req.params

  const sql = "DELETE FROM transactions WHERE id_transactions = ?"
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting transaction:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Transaction deleted successfully" })
      } else {
        res.status(404).json({ error: "Transaction not found" })
      }
    }
  })
})

app.get("/customers", (req, res) => {
  const sql = "SELECT id_customers, name, email, phone FROM customers"
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      res.json(results)
    }
  })
})

app.post("/add-customer", (req, res) => {
  const { name, email, phone } = req.body;

  const checkExistingCustomerSql = "SELECT * FROM customers WHERE name = ? OR email = ? OR phone = ?";
  db.query(checkExistingCustomerSql, [name, email, phone], (err, result) => {
    if (err) {
      console.error("Error checking existing customer:", err);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (result && result.length > 0) {
        res.status(400).json({ error: "Customer with the same name, email, or phone already exists" });
      } else {
        const insertCustomerSql = "INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)";
        db.query(insertCustomerSql, [name, email, phone], (err, result) => {
          if (err) {
            console.error("Error adding customer:", err);
            res.status(500).json({ error: "Internal Server Error" });
          } else {
            res.status(200).json({ message: "Customer added successfully" });
          }
        });
      }
    }
  });
});

app.put("/update-customer/:id", (req, res) => {
  const { id } = req.params;
  const { name, email, phone } = req.body;

  const checkExistingQuery = "SELECT * FROM customers WHERE (name =? OR email = ? OR phone = ?) AND id_customers != ?";
  db.query(checkExistingQuery, [name, email, phone, id], (checkErr, checkResult) => {
    if (checkErr) {
      console.error("Error checking existing customer:", checkErr);
      res.status(500).json({ error: "Internal Server Error" });
    } else if (checkResult.length > 0) {
      res.status(400).json({ error: "Name or email or phone number already exists in the database" });
    } else {
      const updateQuery = "UPDATE customers SET name = ?, email = ?, phone = ? WHERE id_customers = ?";
      db.query(updateQuery, [name, email, phone, id], (err, result) => {
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
    }
  });
});


app.delete("/delete-customer/:id", (req, res) => {
  const { id } = req.params

  const sql = "DELETE FROM customers WHERE id_customers = ?"
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting customer:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer deleted successfully" })
      } else {
        res.status(404).json({ error: "Customer not found" })
      }
    }
  })
})

app.get("/users", (req, res) => {
  const sql =
    "SELECT id_users, firstname, lastname, username, password, role FROM users"
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      res.json(results)
    }
  })
})

app.post("/add-user", (req, res) => {
  const { firstname, lastname, username, password, role } = req.body;

  const sqlCheckExisting =
    "SELECT * FROM users WHERE (firstname = ? AND lastname = ?) OR username = ?";
  db.query(
    sqlCheckExisting,
    [firstname, lastname, username],
    (err, results) => {
      if (err) {
        console.error("Error checking for existing user:", err);
        res.status(500).json({ error: "Internal Server Error" });
      } else if (results.length > 0) {
        res.status(400).json({
          error: "A user with similar data already exists",
        });
      } else {
        const sqlCheckUsername = "SELECT * FROM users WHERE username = ?";
        db.query(sqlCheckUsername, [username], (err, usernameResults) => {
          if (err) {
            console.error("Error checking for existing username:", err);
            res.status(500).json({ error: "Internal Server Error" });
          } else if (usernameResults.length > 0) {
            res.status(400).json({
              error: "Username already exists",
            });
          } else {
            const userRole = role || "Employee";
            const sql =
              "INSERT INTO users (firstname, lastname, username, password, role) VALUES (?, ?, ?, ?, ?)";
            db.query(
              sql,
              [firstname, lastname, username, password, userRole],
              (err, result) => {
                if (err) {
                  console.error("Error adding user:", err);
                  res.status(500).json({ error: "Internal Server Error" });
                } else {
                  res.status(200).json({ message: "User added successfully" });
                }
              }
            );
          }
        });
      }
    }
  );
});


app.put("/update-user/:id", (req, res) => {
  const { id } = req.params;
  const { firstname, lastname, username, role } = req.body;

  const sqlCheckExisting =
    "SELECT * FROM users WHERE (firstname = ? AND lastname = ?) OR username = ?";
  db.query(
    sqlCheckExisting,
    [firstname, lastname, username],
    (err, results) => {
      if (err) {
        console.error("Error checking for existing user:", err);
        res.status(500).json({ error: "Internal Server Error" });
      } else if (results.length > 0) {
        const existingUser = results.find((user) => user.id !== id);
        if (existingUser) {
          res.status(400).json({
            error: "A user with similar data already exists",
          });
        } else {
          updateUser();
        }
      } else {
        updateUser();
      }
    }
  );

  const updateUser = () => {
    const sql =
      "UPDATE users SET firstname = ?, lastname = ?, username = ?, role = ? WHERE id_users = ?";
    db.query(
      sql,
      [firstname, lastname, username, role, id],
      (err, result) => {
        if (err) {
          console.error("Error updating user:", err);
          res.status(500).json({ error: "Internal Server Error" });
        } else {
          if (result.affectedRows > 0) {
            res.status(200).json({ message: "User updated successfully" });
          } else {
            res.status(404).json({ error: "User not found" });
          }
        }
      }
    );
  };
});


app.delete("/delete-user/:id", (req, res) => {
  const { id } = req.params

  const sql = "DELETE FROM users WHERE id_users = ?"
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Error deleting customer:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Customer deleted successfully" })
      } else {
        res.status(404).json({ error: "Customer not found" })
      }
    }
  })
})

app.get("/products", (req, res) => {
  const sql = "SELECT * FROM products"
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      res.json(results)
    }
  })
})

app.post("/add-product", (req, res) => {
  const { name_product, quantity_product } = req.body;

  const sql =
    "INSERT INTO products (name_product, quantity_product) VALUES (?, ?)";
  
  db.query(sql, [name_product, quantity_product], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        res.status(400).json({ error: "Product with the same name already exists" });
      } else {
        console.error("Error adding product:", err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    } else {
      res.status(200).json({ message: "Product added successfully" });
    }
  });
});

app.put("/update-products/:id", (req, res) => {
  const { id } = req.params;
  const { name_product, quantity_product } = req.body;

  const sqlSelect = "SELECT * FROM products WHERE name_product = ? AND id_product <> ?";
  db.query(sqlSelect, [name_product, id], (selectErr, selectResult) => {
    if (selectErr) {
      console.error("Error selecting product:", selectErr);
      res.status(500).json({ error: "Internal Server Error" });
    } else {
      if (selectResult.length > 0) {
        res.status(409).json({ error: "Product name already exists" });
      } else {
        const sqlCheckConflict = "SELECT * FROM products WHERE id_product = ?";
        db.query(sqlCheckConflict, [id], (conflictErr, conflictResult) => {
          if (conflictErr) {
            console.error("Error checking for conflict:", conflictErr);
            res.status(500).json({ error: "Internal Server Error" });
          } else {
            if (conflictResult.length === 0) {
              res.status(404).json({ error: "Product not found" });
            } else {
              const sqlUpdate =
                "UPDATE products SET name_product = ?, quantity_product = ? WHERE id_product = ?";
              db.query(sqlUpdate, [name_product, quantity_product, id], (updateErr, updateResult) => {
                if (updateErr) {
                  console.error("Error updating product:", updateErr);
                  res.status(500).json({ error: "Internal Server Error" });
                } else {
                  if (updateResult.affectedRows > 0) {
                    res.status(200).json({ message: "Product updated successfully" });
                  } else {
                    res.status(404).json({ error: "Product not found" });
                  }
                }
              });
            }
          }
        });
      }
    }
  });
});

app.delete("/delete-products/:id", (req, res) => {
  const productId = req.params.id;

  const deleteServiceProductsQuery = `DELETE FROM serviceproducts WHERE product_id = ?`;
  console.log("Deleting from serviceproducts table:", deleteServiceProductsQuery);

  db.query(deleteServiceProductsQuery, [productId], (err1, result1) => {
    if (err1) {
      console.error("Error deleting service products:", err1);
      res.status(500).json({ error: "Error deleting service products" });
    } else {
      const deleteServiceQuery = `DELETE FROM products WHERE id_product = ?`;
      console.log("Deleting from products table:", deleteServiceQuery);

      db.query(deleteServiceQuery, [productId], (err2, result2) => {
        if (err2) {
          console.error("Error deleting product:", err2);
          res.status(500).json({ error: "Error deleting product" });
        } else {
          if (result2.affectedRows > 0) {
            console.log("Service and associated products deleted successfully.");
            res.json({
              message: "Service and associated products deleted successfully.",
            });
          } else {
            console.log("Product not found in products table.");
            res.json({
              message: "Product not found in products table.",
            });
          }
        }
      });
    }
  });
});

app.get("/services-with-products", (req, res) => {
  const query = `
  SELECT
    s.id_service,
    s.name_service,
    s.price_service,
    GROUP_CONCAT(ps.product_id) AS product_id,
    CASE
        WHEN SUM(CASE WHEN p.quantity_product = 0 THEN 1 ELSE 0 END) > 0 THEN 'Unavailable'
        ELSE 'Available'
    END AS availability
  FROM
    services s
  LEFT JOIN
    serviceproducts ps ON s.id_service = ps.service_id
  LEFT JOIN
    products p ON ps.product_id = p.id_product
  GROUP BY
    s.id_service, s.name_service, s.price_service
  `

  db.query(query, (err, results) => {
    if (err) {
      console.error(err)
      res.status(500).send("Server Error")
      return
    }
    res.json(results)
  })
})

app.get("/services", (req, res) => {
  const sql = "SELECT * FROM services"
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error executing query:", err)
      res.status(500).json({ error: "Internal Server Error" })
    } else {
      res.json(results)
    }
  })
})

app.post("/add-service", async (req, res) => {
  try {
    const { name_service, price_service, product_id } = req.body

    const insertServiceQuery =
      "INSERT INTO services (name_service, price_service) VALUES (?, ?)"
    const serviceValues = [name_service, price_service]

    db.query(insertServiceQuery, serviceValues, (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          res.status(400).json({ error: "Service with the same name already exists" });
        } else {
          console.error("Error adding product:", err);
          res.status(500).json({ error: "Internal Server Error" });
        }
      } else {
        res.status(200).json({ message: "Service added successfully" });
      }

      const serviceId = result.insertId

      if (Array.isArray(product_id)) {
        const insertProductsQuery =
          "INSERT INTO serviceproducts (service_id, product_id) VALUES ?"
        const productValues = product_id.map((productId) => [
          serviceId,
          productId,
        ])

        db.query(insertProductsQuery, [productValues], (err) => {
          if (err) {
            throw err
          }

          res
            .status(201)
            .json({ message: "Service added with associated products" })
        })
      } else {
        res.status(400).json({ message: "Invalid product_id format" })
      }
    })
  } catch (error) {
    console.error("Error adding service:", error)
    res.status(500).json({ message: "Internal Server Error" })
  }
})

app.put("/update-service/:id", (req, res) => {
  const serviceId = req.params.id;
  const { name_service, price_service, product_id } = req.body;

  if (!price_service) {
    return res.status(400).json({ error: "Please provide the price_service field." });
  }

  db.beginTransaction(function (err) {
    if (err) {
      return res.status(500).json({ error: "Error beginning transaction." });
    }

    const selectServiceQuery = `
      SELECT name_service
      FROM services
      WHERE id_service = ?
    `;

    db.query(selectServiceQuery, [serviceId], function (error, result) {
      if (error) {
        db.rollback(function () {
          res.status(500).json({ error: "Error retrieving service." });
        });
      } else {
        const existingDataExists = result.length > 0;
        const existingName = existingDataExists ? result[0].name_service : null;

        const updateServiceQuery = `
          UPDATE services
          SET price_service = ?, ${name_service ? "name_service = ?" : ""}
          WHERE id_service = ?
        `;

        const updateParams = name_service ? [price_service, name_service, serviceId] : [price_service, serviceId];

        db.query(updateServiceQuery, updateParams, function (error, result) {
          if (error) {
            db.rollback(function () {
              res.status(500).json({ error: "Cannot edit the name of existing data." });
            });
          } else {
            const deleteServiceProductsQuery = `
              DELETE FROM serviceproducts
              WHERE service_id = ?
            `;

            db.query(deleteServiceProductsQuery, [serviceId], function (error) {
              if (error) {
                db.rollback(function () {
                  res.status(500).json({ error: "Error deleting service products." });
                });
              } else {
                if (product_id && product_id.length > 0) {
                  const insertServiceProductsQuery = `
                    INSERT INTO serviceproducts (service_id, product_id)
                    VALUES (?, ?)
                  `;

                  const productUpdatePromises = [];

                  for (const productId of product_id) {
                    const productUpdatePromise = new Promise((resolve, reject) => {
                      db.query(insertServiceProductsQuery, [serviceId, productId], function (error, result) {
                        if (error) {
                          reject(error);
                        } else {
                          resolve(result);
                        }
                      });
                    });

                    productUpdatePromises.push(productUpdatePromise);
                  }

                  Promise.all(productUpdatePromises)
                    .then(function () {
                      db.commit(function (err) {
                        if (err) {
                          db.rollback(function () {
                            res.status(500).json({ error: "Error committing transaction." });
                          });
                        } else {
                          res.status(200).json({ message: "Service updated successfully." });
                        }
                      });
                    })
                    .catch(function (updateError) {
                      db.rollback(function () {
                        res.status(500).json({ error: "Error updating service products.", updateError });
                      });
                    });
                } else {
                  db.commit(function (err) {
                    if (err) {
                      db.rollback(function () {
                        res.status(500).json({ error: "Error committing transaction." });
                      });
                    } else {
                      res.status(200).json({ message: "Service updated successfully." });
                    }
                  });
                }
              }
            });
          }
        });
      }
    });
  });
});

app.delete("/delete-service/:id_service", (req, res) => {
  const serviceId = req.params.id_service

  const deleteServiceProductsQuery = `DELETE FROM serviceproducts WHERE service_id = ?`

  db.query(deleteServiceProductsQuery, [serviceId], (err1, result1) => {
    if (err1) {
      console.error("Error deleting service products:", err1)
      res.status(500).json({ error: "Error deleting service products" })
    } else {
      const deleteServiceQuery = `DELETE FROM services WHERE id_service = ?`

      db.query(deleteServiceQuery, [serviceId], (err2, result2) => {
        if (err2) {
          console.error("Error deleting service:", err2)
          res.status(500).json({ error: "Error deleting service" })
        } else {
          console.log("Service and associated products deleted successfully.")
          res.json({
            message: "Service and associated products deleted successfully.",
          })
        }
      })
    }
  })
})

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
