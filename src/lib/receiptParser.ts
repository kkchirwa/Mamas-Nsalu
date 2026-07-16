export type ParsedReceipt = {
  amount: number | null;
  reference: string;
  paymentMethod: string;
};

const amountPatterns = [
  /(?:amount|amt|paid|received|deposit|credit|mwk|mk)\D{0,12}([\d,. ]{3,})/i,
  /([\d,. ]{3,})\s*(?:mwk|mk|kwacha)/i,
];

const referencePatterns = [
  /(?:ref(?:erence)?|txn|transaction|trans|rrn|id)\D{0,10}([a-z0-9-]{5,})/i,
  /\b([A-Z0-9]{8,})\b/,
];

export function parseReceiptText(input: string): ParsedReceipt {
  const text = input.trim();
  const amount = findAmount(text);
  const reference = findReference(text);

  return {
    amount,
    reference,
    paymentMethod: guessPaymentMethod(text),
  };
}

function findAmount(text: string): number | null {
  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const normalized = match[1].replace(/[^\d]/g, '');
    const amount = Number(normalized);
    if (Number.isFinite(amount) && amount > 0) {
      return amount;
    }
  }

  return null;
}

function findReference(text: string): string {
  for (const pattern of referencePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return '';
}

function guessPaymentMethod(text: string): string {
  const lowered = text.toLowerCase();

  if (lowered.includes('airtel')) {
    return 'Airtel Money';
  }

  if (lowered.includes('tnm') || lowered.includes('mpamba')) {
    return 'TNM Mpamba';
  }

  if (lowered.includes('bank') || lowered.includes('deposit')) {
    return 'Bank deposit';
  }

  return 'Unknown';
}
