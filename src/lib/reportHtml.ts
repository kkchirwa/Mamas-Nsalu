export type ReportSummary = {
  customerId: number;
  customerName: string;
  totalPaid: number;
  clothes: number;
};

export type ReportTransaction = {
  id: number;
  customerId: number;
  customerName: string;
  amount: number;
  pieces: number;
  paidAt: string;
};

export function buildReportHtml(options: {
  consignmentName: string;
  pricePerItem: number;
  rowsPerBale: number;
  summaries: ReportSummary[];
  transactions: ReportTransaction[];
}) {
  const groups = options.summaries.map((summary, index) => ({
    index,
    summary,
    transactions: options.transactions.filter(
      (transaction) => transaction.customerId === summary.customerId
    ),
  }));

  const rows = groups
    .map(({ index, summary, transactions }) => {
      const span = Math.max(transactions.length, 1);
      const transactionRows =
        transactions.length > 0
          ? transactions
          : [
              {
                id: -summary.customerId,
                customerId: summary.customerId,
                customerName: summary.customerName,
                amount: 0,
                pieces: 0,
                paidAt: '',
              },
            ];

      return transactionRows
        .map((transaction, transactionIndex) => {
          const noCell = transactionIndex === 0 ? `<td rowspan="${span}">${index + 1}</td>` : '';
          const nameCell =
            transactionIndex === 0
              ? `<td rowspan="${span}">${escapeHtml(summary.customerName)}</td>`
              : '';
          const totalPiecesCell =
            transactionIndex === 0 ? `<td rowspan="${span}">${summary.clothes}</td>` : '';
          const totalAmountCell =
            transactionIndex === 0
              ? `<td rowspan="${span}">${formatMoney(summary.totalPaid)}</td>`
              : '';
          const signatureCell =
            transactionIndex === 0 ? `<td rowspan="${span}" class="signature"></td>` : '';

          return `
            <tr>
              ${noCell}
              ${nameCell}
              <td>${transaction.pieces || ''}</td>
              ${totalPiecesCell}
              <td>${transaction.amount ? formatMoney(transaction.amount) : ''}</td>
              ${totalAmountCell}
              ${signatureCell}
            </tr>
          `;
        })
        .join('');
    })
    .join('');

  return `
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #18201d; padding: 28px; }
          table { border-collapse: collapse; width: 100%; }
          caption { font-size: 20px; font-weight: 700; margin-bottom: 12px; text-align: left; }
          th, td { border: 1px solid #bfc8c2; padding: 10px 8px; text-align: left; }
          th { background: #edf4ef; color: #1d3428; }
          .number { width: 42px; }
          .signature { width: 140px; height: 34px; }
          td[rowspan] { vertical-align: middle; }
        </style>
      </head>
      <body>
        <table>
          <caption>${escapeHtml(options.consignmentName)} - ${formatMoney(options.pricePerItem)} per piece</caption>
          <thead>
            <tr>
              <th class="number">No.</th>
              <th>Name</th>
              <th>Pieces</th>
              <th>Total Pieces</th>
              <th>Amount</th>
              <th>Total Amount</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `;
}

export function formatMoney(amount: number) {
  return `MWK ${amount.toLocaleString('en-US')}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };

    return entities[char];
  });
}
