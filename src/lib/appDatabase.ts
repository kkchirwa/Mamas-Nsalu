export type RunResult = {
  lastInsertRowId: number;
};

export type AppDatabase = {
  execAsync: (source: string) => Promise<void>;
  getFirstAsync: <T>(source: string, ...params: unknown[]) => Promise<T | null>;
  getAllAsync: <T>(source: string, ...params: unknown[]) => Promise<T[]>;
  runAsync: (source: string, ...params: unknown[]) => Promise<RunResult>;
};

type ConsignmentRecord = {
  id: number;
  name: string;
  price_per_item: number;
  rows_per_bale: number;
  status: string;
};

type CustomerRecord = {
  id: number;
  name: string;
};

export async function openAppDatabase(): Promise<AppDatabase> {
  return createWebPreviewDatabase();
}

function createWebPreviewDatabase(): AppDatabase {
  let nextConsignmentId = 1;
  let nextCustomerId = 1;
  let nextPaymentId = 1;
  const consignments: ConsignmentRecord[] = [];
  const customers: CustomerRecord[] = [];
  const payments: Array<{
    id: number;
    consignment_id: number;
    customer_id: number;
    amount: number;
    reference_number: string;
    payment_method: string;
    raw_text: string;
    paid_at: string;
  }> = [];

  return {
    async execAsync() {
      return undefined;
    },
    async getFirstAsync<T>(source: string, ...params: unknown[]) {
      if (source.includes('COUNT(*) as count FROM consignments')) {
        return { count: consignments.filter((row) => row.status === 'active').length } as T;
      }

      if (source.includes('FROM consignments WHERE status')) {
        return (consignments.find((row) => row.status === params[0]) ?? null) as T | null;
      }

      if (source.includes('FROM customers WHERE lower(name)')) {
        const name = String(params[0] ?? '').toLowerCase();
        return (customers.find((customer) => customer.name.toLowerCase() === name) ?? null) as T | null;
      }

      return null;
    },
    async getAllAsync<T>(source: string, ...params: unknown[]) {
      if (source.includes('SELECT * FROM customers')) {
        return [...customers].sort((a, b) => a.name.localeCompare(b.name)) as T[];
      }

      if (source.includes('p.customer_id as customerId')) {
        const consignmentId = Number(params[1]);
        const active = consignments.find((row) => row.id === consignmentId);

        if (!active) {
          return [];
        }

        return payments
          .filter((payment) => payment.consignment_id === consignmentId)
          .map((payment) => {
            const customer = customers.find((row) => row.id === payment.customer_id);
            return {
              id: payment.id,
              amount: payment.amount,
              referenceNumber: payment.reference_number,
              paymentMethod: payment.payment_method,
              paidAt: payment.paid_at,
              customerId: payment.customer_id,
              customerName: customer?.name ?? 'Unknown',
              pieces: Math.floor(payment.amount / active.price_per_item),
            };
          })
          .sort(
            (a, b) =>
              a.customerName.localeCompare(b.customerName) || a.paidAt.localeCompare(b.paidAt)
          ) as T[];
      }

      if (source.includes('FROM payments p')) {
        const consignmentId = Number(params[0]);
        const active = consignments.find((row) => row.id === consignmentId);
        if (!active) {
          return [];
        }

        const byCustomer = new Map<number, number>();
        payments
          .filter((payment) => payment.consignment_id === consignmentId)
          .forEach((payment) => {
            byCustomer.set(
              payment.customer_id,
              (byCustomer.get(payment.customer_id) ?? 0) + payment.amount
            );
          });

        return Array.from(byCustomer.entries())
          .map(([customerId, totalPaid]) => {
            const customer = customers.find((row) => row.id === customerId);
            return {
              customerId,
              customerName: customer?.name ?? 'Unknown',
              totalPaid,
              clothes: Math.floor(totalPaid / active.price_per_item),
            };
          })
          .sort((a, b) => a.customerName.localeCompare(b.customerName)) as T[];
      }

      if (source.includes('FROM payments') && source.includes('customer_id')) {
        const consignmentId = Number(params[1]);
        const customerId = Number(params[2]);
        const active = consignments.find((row) => row.id === consignmentId);

        if (!active) {
          return [];
        }

        return payments
          .filter(
            (payment) =>
              payment.consignment_id === consignmentId && payment.customer_id === customerId
          )
          .map((payment) => ({
            id: payment.id,
            amount: payment.amount,
            referenceNumber: payment.reference_number,
            paymentMethod: payment.payment_method,
            paidAt: payment.paid_at,
            pieces: Math.floor(payment.amount / active.price_per_item),
          }))
          .sort((a, b) => b.paidAt.localeCompare(a.paidAt)) as T[];
      }

      return [];
    },
    async runAsync(source: string, ...params: unknown[]) {
      if (source.includes('INSERT INTO consignments')) {
        const id = nextConsignmentId++;
        consignments.push({
          id,
          name: String(params[0]),
          price_per_item: Number(params[1]),
          rows_per_bale: Number(params[2]),
          status: String(params[3]),
        });
        return { lastInsertRowId: id };
      }

      if (source.includes('INSERT INTO customers')) {
        const id = nextCustomerId++;
        customers.push({ id, name: String(params[0]) });
        return { lastInsertRowId: id };
      }

      if (source.includes('INSERT INTO payments')) {
        const id = nextPaymentId++;
        payments.push({
          id,
          consignment_id: Number(params[0]),
          customer_id: Number(params[1]),
          amount: Number(params[2]),
          reference_number: String(params[3] ?? ''),
          payment_method: String(params[4] ?? ''),
          raw_text: String(params[5] ?? ''),
          paid_at: new Date().toISOString(),
        });
        return { lastInsertRowId: id };
      }

      return { lastInsertRowId: 0 };
    },
  };
}
