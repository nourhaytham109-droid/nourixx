CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(40) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'cashier')),
  page_permissions JSONB NOT NULL DEFAULT '["pos","orders","order-report","reports","expenses","menu","customers"]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shifts (
  id BIGSERIAL PRIMARY KEY,
  opened_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  sales_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cash_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cash_wallet_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  visa_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  expenses_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  opening_cash_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cash_expenses_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cashier_due_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  expected_drawer_cash_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cancelled_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shifts_opened_at_idx ON shifts (opened_at DESC);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opening_cash_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cash_expenses_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cashier_due_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS expected_drawer_cash_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cancelled_total NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS shift_cash_float_entries (
  id BIGSERIAL PRIMARY KEY,
  shift_id BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  cashier_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shift_id, cashier_id)
);
CREATE INDEX IF NOT EXISTS shift_cash_float_entries_shift_idx ON shift_cash_float_entries (shift_id);
ALTER TABLE users DROP COLUMN IF EXISTS name;
ALTER TABLE users ADD COLUMN IF NOT EXISTS page_permissions JSONB NOT NULL
  DEFAULT '["pos","orders","order-report","reports","expenses","menu","customers"]'::jsonb;
ALTER TABLE users ALTER COLUMN page_permissions SET DEFAULT
  '["pos","orders","order-report","reports","expenses","menu","customers"]'::jsonb;
UPDATE users SET page_permissions = (page_permissions - 'inventory') || '["menu"]'::jsonb
WHERE page_permissions ? 'inventory';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS delivery_drivers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_collections (
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES delivery_drivers(id),
  collected_by BIGINT NOT NULL REFERENCES users(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS delivery_collections_driver_idx ON delivery_collections (driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(240) NOT NULL DEFAULT '',
  category VARCHAR(60) NOT NULL,
  image_url VARCHAR(240),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  size_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS product_categories (
  name VARCHAR(60) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS size_prices JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url VARCHAR(240);
ALTER TABLE products DROP COLUMN IF EXISTS emoji;
ALTER TABLE products DROP COLUMN IF EXISTS stock;
ALTER TABLE products DROP COLUMN IF EXISTS low_stock_threshold;
UPDATE products
SET size_prices = jsonb_build_object(
  'small', price,
  'medium', price,
  'large', price
)
WHERE size_prices = '{}'::jsonb;
CREATE INDEX IF NOT EXISTS products_active_category_idx ON products (active, category);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address VARCHAR(240) NOT NULL,
  delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 10 CHECK (delivery_fee >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, address)
);
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 10;

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_number VARCHAR(24) NOT NULL UNIQUE,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  order_type VARCHAR(16) NOT NULL CHECK (order_type IN ('takeaway', 'delivery', 'reservation')),
  status VARCHAR(20) NOT NULL DEFAULT 'قيد التحضير'
    CHECK (status IN ('قيد التحضير', 'جاهز', 'في الطريق', 'مكتمل', 'ملغي')),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  payment_method VARCHAR(16) NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'cash_wallet', 'visa')),
  driver_id BIGINT REFERENCES delivery_drivers(id) ON DELETE SET NULL,
  printed_at TIMESTAMPTZ,
  total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
  delivery_address VARCHAR(240) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  reservation_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason VARCHAR(240) NOT NULL DEFAULT '',
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  shift_order_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('قيد التحضير', 'جاهز', 'في الطريق', 'مكتمل', 'ملغي'));
ALTER TABLE orders DROP COLUMN IF EXISTS tax;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address VARCHAR(240) NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id BIGINT REFERENCES delivery_drivers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(240) NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16) NOT NULL DEFAULT 'cash'
  CHECK (payment_method IN ('cash', 'cash_wallet', 'visa'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_order_number INTEGER;
WITH matched_orders AS (
  SELECT o.id, o.created_at, (
    SELECT s.id
    FROM shifts s
    WHERE s.opened_at <= o.created_at
      AND (s.closed_at IS NULL OR s.closed_at >= o.created_at)
    ORDER BY s.opened_at DESC
    LIMIT 1
  ) AS matched_shift_id
  FROM orders o
  WHERE o.shift_id IS NULL
), numbered_orders AS (
  SELECT id, matched_shift_id,
         ROW_NUMBER() OVER (PARTITION BY matched_shift_id ORDER BY created_at, id)::INTEGER AS shift_order_number
  FROM matched_orders
  WHERE matched_shift_id IS NOT NULL
)
UPDATE orders o
SET shift_id = numbered_orders.matched_shift_id,
    shift_order_number = numbered_orders.shift_order_number
FROM numbered_orders
WHERE o.id = numbered_orders.id;
CREATE UNIQUE INDEX IF NOT EXISTS orders_shift_order_number_idx
  ON orders (shift_id, shift_order_number)
  WHERE shift_id IS NOT NULL AND shift_order_number IS NOT NULL;
UPDATE orders
SET status = 'في الطريق', assigned_at = COALESCE(assigned_at, NOW())
WHERE driver_id IS NOT NULL
  AND order_type IN ('delivery', 'reservation')
  AND status = 'قيد التحضير';
UPDATE orders SET completed_at = NOW() WHERE status = 'مكتمل' AND completed_at IS NULL;
UPDATE orders SET cancelled_at = COALESCE(completed_at, created_at) WHERE status = 'ملغي' AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(100) NOT NULL,
  size_key VARCHAR(12) NOT NULL DEFAULT 'medium'
    CHECK (size_key IN ('small', 'medium', 'large')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size_key VARCHAR(12) NOT NULL DEFAULT 'medium'
  CHECK (size_key IN ('small', 'medium', 'large'));
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

DROP TABLE IF EXISTS inventory_movements;

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(40) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment VARCHAR(30) NOT NULL,
  note VARCHAR(240) NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS expenses_created_idx ON expenses (created_at DESC);
CREATE INDEX IF NOT EXISTS expenses_shift_idx ON expenses (shift_id);

INSERT INTO products (name, description, category, price)
VALUES
  ('برجر كلاسيك', 'لحم بقري، خس، طماطم، صوص', 'برجر', 145),
  ('تشيز برجر', 'لحم بقري مع جبنة شيدر', 'برجر', 165),
  ('برجر دجاج كرسبي', 'دجاج مقرمش وصوص خاص', 'برجر', 135),
  ('بيتزا مارجريتا', 'جبنة موتزاريلا وطماطم', 'بيتزا', 180),
  ('بيتزا بيبروني', 'بيبروني، موتزاريلا، صوص', 'بيتزا', 220),
  ('بيتزا خضار', 'فلفل، زيتون، مشروم', 'بيتزا', 195),
  ('بطاطس مقلية', 'بطاطس ذهبية مقرمشة', 'مقبلات', 55),
  ('أجنحة باربكيو', '6 قطع بصوص باربكيو', 'مقبلات', 115),
  ('حلقات بصل', 'حلقات بصل مقرمشة', 'مقبلات', 65),
  ('كولا', 'علبة 330 مل', 'مشروبات', 25),
  ('عصير برتقال', 'عصير طازج 250 مل', 'مشروبات', 45),
  ('مياه معدنية', 'زجاجة 500 مل', 'مشروبات', 15)
ON CONFLICT DO NOTHING;
INSERT INTO product_categories (name)
SELECT DISTINCT category FROM products
ON CONFLICT (name) DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_category_fkey'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_category_fkey
      FOREIGN KEY (category) REFERENCES product_categories(name)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;
