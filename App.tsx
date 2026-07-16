import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { formatMoney, buildReportHtml } from './src/lib/reportHtml';
import { parseReceiptText } from './src/lib/receiptParser';
import { openAppDatabase, type AppDatabase } from './src/lib/appDatabase';
import { formatRollsAndPieces } from './src/lib/rolls';
import { recognizeImageText } from './src/lib/recognizeImageText';

type TabKey = 'overview' | 'receipt' | 'customers' | 'report';

type Consignment = {
  id: number;
  name: string;
  price_per_item: number;
  rows_per_bale: number;
  status: string;
};

type Customer = {
  id: number;
  name: string;
};

type Summary = {
  customerId: number;
  customerName: string;
  totalPaid: number;
  clothes: number;
};

type PaymentDetail = {
  id: number;
  amount: number;
  pieces: number;
  paidAt: string;
  referenceNumber: string;
  paymentMethod: string;
};

type ReportTransaction = PaymentDetail & {
  customerId: number;
  customerName: string;
};

const SAMPLE_RECEIPT =
  'Airtel Money: You have received MWK 60,000 from customer. Ref TXN98451230. Balance MWK 120,000.';

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Home' },
  { key: 'receipt', label: 'Receipt' },
  { key: 'customers', label: 'People' },
  { key: 'report', label: 'Report' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [db, setDb] = useState<AppDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [consignment, setConsignment] = useState<Consignment | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [selectedPayments, setSelectedPayments] = useState<PaymentDetail[]>([]);
  const [customerModalVisible, setCustomerModalVisible] = useState(false);
  const [reportTransactions, setReportTransactions] = useState<ReportTransaction[]>([]);
  const [receiptText, setReceiptText] = useState(SAMPLE_RECEIPT);
  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [saving, setSaving] = useState(false);
  const [recognizingImage, setRecognizingImage] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function boot() {
      const database = await openAppDatabase();
      await setupDatabase(database);

      if (!isMounted) {
        return;
      }

      setDb(database);
      await refresh(database);
      setLoading(false);
    }

    boot().catch((error) => {
      setLoading(false);
      Alert.alert('Could not open database', String(error));
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const totals = useMemo(() => {
    const totalPaid = summaries.reduce((sum, row) => sum + row.totalPaid, 0);
    const totalClothes = summaries.reduce((sum, row) => sum + row.clothes, 0);
    const rollsLabel = consignment
      ? formatRollsAndPieces(totalClothes, consignment.rows_per_bale)
      : '0 pieces';

    return { totalPaid, totalClothes, rollsLabel };
  }, [consignment, summaries]);

  const suggestions = useMemo(() => {
    const search = customerName.trim().toLowerCase();
    if (!search) {
      return customers.slice(0, 4);
    }

    return customers
      .filter((customer) => customer.name.toLowerCase().includes(search))
      .slice(0, 4);
  }, [customerName, customers]);

  async function refresh(database = db) {
    if (!database) {
      return;
    }

    const active = await database.getFirstAsync<Consignment>(
      'SELECT * FROM consignments WHERE status = ? ORDER BY id DESC LIMIT 1',
      'active'
    );

    const allCustomers = await database.getAllAsync<Customer>(
      'SELECT * FROM customers ORDER BY name COLLATE NOCASE'
    );

    setConsignment(active);
    setCustomers(allCustomers);

    if (!active) {
      setSummaries([]);
      setReportTransactions([]);
      return;
    }

    const rows = await database.getAllAsync<Summary>(
      `
        SELECT
          c.id as customerId,
          c.name as customerName,
          SUM(p.amount) as totalPaid,
          CAST(SUM(p.amount) / co.price_per_item AS INTEGER) as clothes
        FROM payments p
        JOIN customers c ON c.id = p.customer_id
        JOIN consignments co ON co.id = p.consignment_id
        WHERE p.consignment_id = ?
        GROUP BY c.id, c.name
        ORDER BY c.name COLLATE NOCASE
      `,
      active.id
    );

    setSummaries(rows);
    await loadReportTransactions(database, active);

    if (selectedCustomerId) {
      await loadCustomerPayments(selectedCustomerId, database, active);
    }
  }

  async function loadReportTransactions(database = db, activeConsignment = consignment) {
    if (!database || !activeConsignment) {
      return;
    }

    const rows = await database.getAllAsync<ReportTransaction>(
      `
        SELECT
          p.id,
          p.amount,
          p.reference_number as referenceNumber,
          p.payment_method as paymentMethod,
          p.paid_at as paidAt,
          p.customer_id as customerId,
          c.name as customerName,
          CAST(p.amount / ? AS INTEGER) as pieces
        FROM payments p
        JOIN customers c ON c.id = p.customer_id
        WHERE p.consignment_id = ?
        ORDER BY c.name COLLATE NOCASE, p.paid_at ASC, p.id ASC
      `,
      activeConsignment.price_per_item,
      activeConsignment.id
    );

    setReportTransactions(rows);
  }

  async function loadCustomerPayments(
    customerId: number,
    database = db,
    activeConsignment = consignment
  ) {
    if (!database || !activeConsignment) {
      return;
    }

    const rows = await database.getAllAsync<PaymentDetail>(
      `
        SELECT
          id,
          amount,
          reference_number as referenceNumber,
          payment_method as paymentMethod,
          paid_at as paidAt,
          CAST(amount / ? AS INTEGER) as pieces
        FROM payments
        WHERE consignment_id = ? AND customer_id = ?
        ORDER BY paid_at DESC, id DESC
      `,
      activeConsignment.price_per_item,
      activeConsignment.id,
      customerId
    );

    setSelectedCustomerId(customerId);
    setSelectedPayments(rows);
    setCustomerModalVisible(true);
  }

  function closeCustomerPayments() {
    setCustomerModalVisible(false);
  }

  function extractReceipt() {
    const parsed = parseReceiptText(receiptText);

    setAmount(parsed.amount ? String(parsed.amount) : '');
    setReference(parsed.reference);
    setPaymentMethod(parsed.paymentMethod);
  }

  async function readReceiptImage() {
    setRecognizingImage(true);

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });

      if (result.canceled || !result.assets[0]?.uri) {
        return;
      }

      const text = await recognizeImageText(result.assets[0].uri);
      setReceiptText(text);

      const parsed = parseReceiptText(text);
      setAmount(parsed.amount ? String(parsed.amount) : '');
      setReference(parsed.reference);
      setPaymentMethod(parsed.paymentMethod);
    } catch (error) {
      Alert.alert('Could not read image', String(error));
    } finally {
      setRecognizingImage(false);
    }
  }

  async function savePayment() {
    if (!db || !consignment) {
      return;
    }

    const cleanCustomerName = customerName.trim();
    const cleanAmount = Number(amount.replace(/[^\d]/g, ''));

    if (!cleanCustomerName) {
      Alert.alert('Customer needed', 'Enter the name of the person who paid.');
      return;
    }

    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
      Alert.alert('Amount needed', 'Enter a valid payment amount.');
      return;
    }

    setSaving(true);

    try {
      let customer = await db.getFirstAsync<Customer>(
        'SELECT * FROM customers WHERE lower(name) = lower(?) LIMIT 1',
        cleanCustomerName
      );

      if (!customer) {
        const result = await db.runAsync('INSERT INTO customers (name) VALUES (?)', cleanCustomerName);
        customer = { id: result.lastInsertRowId, name: cleanCustomerName };
      }

      await db.runAsync(
        `
          INSERT INTO payments (
            consignment_id,
            customer_id,
            amount,
            reference_number,
            payment_method,
            raw_text,
            paid_at
          )
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `,
        consignment.id,
        customer.id,
        cleanAmount,
        reference.trim(),
        paymentMethod.trim() || 'Unknown',
        receiptText.trim()
      );

      setCustomerName('');
      setReceiptText('');
      setAmount('');
      setReference('');
      setPaymentMethod('');
      await refresh();
      setActiveTab('overview');
    } catch (error) {
      Alert.alert('Could not save payment', String(error));
    } finally {
      setSaving(false);
    }
  }

  async function exportReport() {
    if (!consignment) {
      return;
    }

    const html = buildReportHtml({
      consignmentName: consignment.name,
      pricePerItem: consignment.price_per_item,
      rowsPerBale: consignment.rows_per_bale,
      summaries,
      transactions: reportTransactions,
    });

    if (Platform.OS === 'web') {
      const popup = window.open('', '_blank');
      if (!popup) {
        Alert.alert('Could not open print window', 'Allow popups and try again.');
        return;
      }

      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      popup.focus();
      popup.print();
      return;
    }

    const file = await Print.printToFileAsync({ html });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri);
    } else {
      Alert.alert('PDF created', file.uri);
    }
  }

  if (loading) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color={colors.green} />
        <Text style={styles.loadingText}>Opening offline database...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <StatusBar style="dark" />
      <View style={styles.appFrame}>
        <AppHeader consignment={consignment} activeTab={activeTab} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {activeTab === 'overview' ? (
            <OverviewScreen
              totals={totals}
              summaries={summaries}
              onAddReceipt={() => setActiveTab('receipt')}
              onOpenReport={() => setActiveTab('report')}
            />
          ) : null}

          {activeTab === 'receipt' ? (
            <ReceiptScreen
              amount={amount}
              customerName={customerName}
              paymentMethod={paymentMethod}
              receiptText={receiptText}
              reference={reference}
              recognizingImage={recognizingImage}
              saving={saving}
              suggestions={suggestions}
              onAmountChange={setAmount}
              onCustomerNameChange={setCustomerName}
              onExtract={extractReceipt}
              onPaymentMethodChange={setPaymentMethod}
              onReadImage={readReceiptImage}
              onReceiptTextChange={setReceiptText}
              onReferenceChange={setReference}
              onSave={savePayment}
            />
          ) : null}

          {activeTab === 'customers' ? (
            <CustomersScreen
              summaries={summaries}
              customers={customers}
              selectedCustomerId={selectedCustomerId}
              selectedPayments={selectedPayments}
              visible={customerModalVisible}
              onCloseCustomer={closeCustomerPayments}
              onSelectCustomer={loadCustomerPayments}
            />
          ) : null}

          {activeTab === 'report' ? (
            <ReportScreen
              consignment={consignment}
              reportTransactions={reportTransactions}
              summaries={summaries}
              totals={totals}
              onExport={exportReport}
            />
          ) : null}
        </ScrollView>
        <BottomNav activeTab={activeTab} onChange={setActiveTab} />
      </View>
    </KeyboardAvoidingView>
  );
}

function AppHeader({
  activeTab,
  consignment,
}: {
  activeTab: TabKey;
  consignment: Consignment | null;
}) {
  const titles: Record<TabKey, string> = {
    overview: 'Overview',
    receipt: 'Add receipt',
    customers: 'Customers',
    report: 'Report',
  };

  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.appName}>Mama Sales</Text>
        <Text style={styles.headerTitle}>{titles[activeTab]}</Text>
      </View>
      <View style={styles.statusPill}>
        <Text style={styles.statusText}>{consignment?.name ?? 'No batch'}</Text>
      </View>
    </View>
  );
}

function OverviewScreen({
  onAddReceipt,
  onOpenReport,
  summaries,
  totals,
}: {
  onAddReceipt: () => void;
  onOpenReport: () => void;
  summaries: Summary[];
  totals: { totalPaid: number; totalClothes: number; rollsLabel: string };
}) {
  const topCustomers = summaries.slice(0, 3);

  return (
    <View style={styles.stack}>
      <View style={styles.heroPanel}>
        <Text style={styles.heroLabel}>Current batch</Text>
        <Text style={styles.heroValue}>{formatMoney(totals.totalPaid)}</Text>
        <Text style={styles.heroMeta}>
          {totals.totalClothes} pieces recorded as {totals.rollsLabel}
        </Text>
        <View style={styles.actionRow}>
          <Pressable style={styles.primaryButtonCompact} onPress={onAddReceipt}>
            <Text style={styles.primaryButtonCompactText}>Add receipt</Text>
          </Pressable>
          <Pressable style={styles.secondaryButtonCompact} onPress={onOpenReport}>
            <Text style={styles.secondaryButtonCompactText}>View report</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Received" value={formatMoney(totals.totalPaid)} />
        <Stat label="Pieces" value={String(totals.totalClothes)} />
        <Stat label="Rolls" value={totals.rollsLabel} />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent customers</Text>
          <Text style={styles.sectionCount}>{summaries.length}</Text>
        </View>
        {topCustomers.length === 0 ? (
          <Text style={styles.emptyText}>No payments saved yet.</Text>
        ) : (
          topCustomers.map((summary) => <CustomerSummaryRow key={summary.customerId} summary={summary} />)
        )}
      </View>
    </View>
  );
}

function ReceiptScreen({
  amount,
  customerName,
  onAmountChange,
  onCustomerNameChange,
  onExtract,
  onPaymentMethodChange,
  onReadImage,
  onReceiptTextChange,
  onReferenceChange,
  onSave,
  paymentMethod,
  receiptText,
  reference,
  recognizingImage,
  saving,
  suggestions,
}: {
  amount: string;
  customerName: string;
  onAmountChange: (value: string) => void;
  onCustomerNameChange: (value: string) => void;
  onExtract: () => void;
  onPaymentMethodChange: (value: string) => void;
  onReadImage: () => void;
  onReceiptTextChange: (value: string) => void;
  onReferenceChange: (value: string) => void;
  onSave: () => void;
  paymentMethod: string;
  receiptText: string;
  reference: string;
  recognizingImage: boolean;
  saving: boolean;
  suggestions: Customer[];
}) {
  return (
    <View style={styles.stack}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Receipt details</Text>
        <TextInput
          multiline
          placeholder="Paste shared SMS or OCR text here"
          style={[styles.input, styles.textArea]}
          value={receiptText}
          onChangeText={onReceiptTextChange}
        />
        <Pressable style={styles.secondaryButton} onPress={onExtract}>
          <Text style={styles.secondaryButtonText}>Extract amount and reference</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onReadImage} disabled={recognizingImage}>
          <Text style={styles.secondaryButtonText}>
            {recognizingImage ? 'Reading image...' : 'Read text from image'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Confirm payment</Text>
        <InputBlock label="Customer">
          <TextInput
            placeholder="Who deposited?"
            style={styles.input}
            value={customerName}
            onChangeText={onCustomerNameChange}
          />
        </InputBlock>

        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestions.map((customer) => (
              <Pressable
                key={customer.id}
                style={styles.suggestion}
                onPress={() => onCustomerNameChange(customer.name)}
              >
                <Text style={styles.suggestionText}>{customer.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.twoColumns}>
          <InputBlock label="Amount" style={styles.field}>
            <TextInput
              keyboardType="number-pad"
              placeholder="60000"
              style={styles.input}
              value={amount}
              onChangeText={onAmountChange}
            />
          </InputBlock>
          <InputBlock label="Method" style={styles.field}>
            <TextInput
              placeholder="Airtel Money"
              style={styles.input}
              value={paymentMethod}
              onChangeText={onPaymentMethodChange}
            />
          </InputBlock>
        </View>

        <InputBlock label="Reference">
          <TextInput
            placeholder="TXN98451230"
            style={styles.input}
            value={reference}
            onChangeText={onReferenceChange}
          />
        </InputBlock>

        <Pressable style={styles.primaryButton} onPress={onSave} disabled={saving}>
          <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : 'Save payment'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function CustomersScreen({
  customers,
  onCloseCustomer,
  onSelectCustomer,
  selectedCustomerId,
  selectedPayments,
  summaries,
  visible,
}: {
  customers: Customer[];
  onCloseCustomer: () => void;
  onSelectCustomer: (customerId: number) => void;
  selectedCustomerId: number | null;
  selectedPayments: PaymentDetail[];
  summaries: Summary[];
  visible: boolean;
}) {
  const selectedSummary = summaries.find((summary) => summary.customerId === selectedCustomerId);

  return (
    <View style={styles.stack}>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Customer totals</Text>
          <Text style={styles.sectionCount}>{customers.length}</Text>
        </View>
        {summaries.length === 0 ? (
          <Text style={styles.emptyText}>Customers will appear after the first payment is saved.</Text>
        ) : (
          summaries.map((summary) => (
            <CustomerSummaryRow
              key={summary.customerId}
              selected={summary.customerId === selectedCustomerId}
              summary={summary}
              onPress={() => onSelectCustomer(summary.customerId)}
            />
          ))
        )}
      </View>

      <Modal transparent animationType="fade" visible={visible} onRequestClose={onCloseCustomer}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalPanel}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>{selectedSummary?.customerName ?? 'Customer'}</Text>
                <Text style={styles.modalMeta}>{selectedPayments.length} transactions</Text>
              </View>
              <Pressable style={styles.closeButton} onPress={onCloseCustomer}>
                <Text style={styles.closeButtonText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.modalList} contentContainerStyle={styles.modalListContent}>
              {selectedPayments.length === 0 ? (
                <Text style={styles.emptyText}>No transactions for this customer yet.</Text>
              ) : (
                selectedPayments.map((payment) => (
                  <View key={payment.id} style={styles.paymentRow}>
                    <View style={styles.paymentMain}>
                      <Text style={styles.paymentAmount}>{formatMoney(payment.amount)}</Text>
                      <Text style={styles.paymentMeta}>
                        {payment.pieces} pieces - {formatDate(payment.paidAt)}
                      </Text>
                    </View>
                    <View style={styles.paymentSide}>
                      <Text style={styles.paymentMethod}>{payment.paymentMethod || 'Unknown'}</Text>
                      <Text style={styles.paymentReference}>{payment.referenceNumber || 'No ref'}</Text>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ReportScreen({
  consignment,
  onExport,
  reportTransactions,
  summaries,
  totals,
}: {
  consignment: Consignment | null;
  onExport: () => void;
  reportTransactions: ReportTransaction[];
  summaries: Summary[];
  totals: { totalPaid: number; totalClothes: number; rollsLabel: string };
}) {
  return (
    <View style={styles.stack}>
      <View style={styles.reportHeader}>
        <Text style={styles.reportTitle}>{consignment?.name ?? 'Current batch'}</Text>
        <Text style={styles.reportMeta}>
          {summaries.length} customers - {reportTransactions.length} transactions
        </Text>
        <Pressable style={styles.primaryButton} onPress={onExport}>
          <Text style={styles.primaryButtonText}>Generate PDF</Text>
        </Pressable>
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Received" value={formatMoney(totals.totalPaid)} />
        <Stat label="Pieces" value={String(totals.totalClothes)} />
        <Stat label="Rolls" value={totals.rollsLabel} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Report preview</Text>
        {reportTransactions.length === 0 ? (
          <Text style={styles.emptyText}>No report rows yet.</Text>
        ) : (
          <View style={styles.reportTable}>
            <View style={[styles.reportTableRow, styles.reportTableHeader]}>
              <Text style={[styles.reportCell, styles.reportNumberCell]}>No.</Text>
              <Text style={[styles.reportCell, styles.reportNameCell]}>Name</Text>
              <Text style={styles.reportCell}>Pieces</Text>
              <Text style={styles.reportCell}>Total Pieces</Text>
              <Text style={styles.reportCell}>Amount</Text>
              <Text style={styles.reportCell}>Total Amount</Text>
              <Text style={styles.reportCell}>Sign</Text>
            </View>
            {reportTransactions.map((transaction, index) => {
              const firstForCustomer =
                index === 0 || reportTransactions[index - 1].customerId !== transaction.customerId;
              const summary = summaries.find((row) => row.customerId === transaction.customerId);

              return (
                <View key={transaction.id} style={styles.reportTableRow}>
                  <Text style={[styles.reportCell, styles.reportNumberCell]}>
                    {firstForCustomer ? summaries.findIndex((row) => row.customerId === transaction.customerId) + 1 : ''}
                  </Text>
                  <Text style={[styles.reportCell, styles.reportNameCell]}>
                    {firstForCustomer ? transaction.customerName : ''}
                  </Text>
                  <Text style={styles.reportCell}>{transaction.pieces}</Text>
                  <Text style={styles.reportCell}>{firstForCustomer ? summary?.clothes ?? '' : ''}</Text>
                  <Text style={styles.reportCell}>{formatMoney(transaction.amount)}</Text>
                  <Text style={styles.reportCell}>
                    {firstForCustomer && summary ? formatMoney(summary.totalPaid) : ''}
                  </Text>
                  <Text style={styles.reportCell}></Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

function BottomNav({
  activeTab,
  onChange,
}: {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <View style={styles.bottomNav}>
      {tabs.map((tab) => {
        const active = activeTab === tab.key;
        return (
          <Pressable
            key={tab.key}
            style={[styles.navItem, active ? styles.navItemActive : null]}
            onPress={() => onChange(tab.key)}
          >
            <Text style={[styles.navLabel, active ? styles.navLabelActive : null]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CustomerSummaryRow({
  onPress,
  selected = false,
  summary,
}: {
  onPress?: () => void;
  selected?: boolean;
  summary: Summary;
}) {
  const content = (
    <>
      <View style={styles.customerAvatar}>
        <Text style={styles.customerAvatarText}>{summary.customerName.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.customerDetails}>
        <Text style={styles.customerName}>{summary.customerName}</Text>
        <Text style={styles.customerMeta}>{summary.clothes} pieces</Text>
      </View>
      <Text style={styles.customerAmount}>{formatMoney(summary.totalPaid)}</Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        style={[styles.customerRow, selected ? styles.customerRowSelected : null]}
        onPress={onPress}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={styles.customerRow}>
      {content}
    </View>
  );
}

function InputBlock({
  children,
  label,
  style,
}: {
  children: ReactNode;
  label: string;
  style?: object;
}) {
  return (
    <View style={[styles.inputBlock, style]}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

async function setupDatabase(db: AppDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS consignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL DEFAULT CURRENT_DATE,
      end_date TEXT,
      price_per_item INTEGER NOT NULL DEFAULT 20000,
      rows_per_bale INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consignment_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reference_number TEXT,
      payment_method TEXT,
      raw_text TEXT,
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (consignment_id) REFERENCES consignments(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  const active = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM consignments WHERE status = 'active'"
  );

  if (!active?.count) {
    await db.runAsync(
      'INSERT INTO consignments (name, price_per_item, rows_per_bale, status) VALUES (?, ?, ?, ?)',
      'June Consignment',
      20000,
      20,
      'active'
    );
  }
}

const colors = {
  background: '#f7f5ef',
  card: '#fffdf8',
  ink: '#17211c',
  muted: '#68746e',
  line: '#ded8cb',
  softGreen: '#edf4ef',
  green: '#1f6b4a',
  greenDark: '#133d2b',
  gold: '#bb8428',
  goldSoft: '#fbf2df',
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  appFrame: {
    alignSelf: 'center',
    backgroundColor: colors.background,
    flex: 1,
    maxWidth: 520,
    width: '100%',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    gap: 10,
  },
  loadingText: {
    color: colors.muted,
  },
  header: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    paddingTop: 50,
  },
  appName: {
    color: colors.green,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  headerTitle: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: '800',
    marginTop: 2,
  },
  statusPill: {
    backgroundColor: colors.softGreen,
    borderRadius: 999,
    maxWidth: 170,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusText: {
    color: colors.greenDark,
    fontSize: 12,
    fontWeight: '800',
  },
  content: {
    padding: 16,
    paddingBottom: 104,
  },
  stack: {
    gap: 14,
  },
  heroPanel: {
    backgroundColor: colors.greenDark,
    borderRadius: 8,
    padding: 18,
    gap: 8,
  },
  heroLabel: {
    color: '#cfe2d8',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  heroValue: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '900',
  },
  heroMeta: {
    color: '#d9e7df',
    fontSize: 14,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 78,
    padding: 12,
    justifyContent: 'space-between',
  },
  statLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  statValue: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  section: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  sectionCount: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  label: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  inputBlock: {
    gap: 7,
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textArea: {
    minHeight: 124,
    textAlignVertical: 'top',
  },
  twoColumns: {
    flexDirection: 'row',
    gap: 10,
  },
  field: {
    flex: 1,
  },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestion: {
    backgroundColor: colors.softGreen,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  suggestionText: {
    color: colors.greenDark,
    fontWeight: '800',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.green,
    borderRadius: 8,
    minHeight: 50,
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryButtonCompact: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    flex: 1,
    minHeight: 46,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  primaryButtonCompactText: {
    color: colors.greenDark,
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.green,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: 'center',
  },
  secondaryButtonCompact: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.28)',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 46,
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: colors.green,
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryButtonCompactText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  customerRow: {
    alignItems: 'center',
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 12,
  },
  customerRowSelected: {
    backgroundColor: colors.softGreen,
    borderRadius: 8,
    borderTopWidth: 0,
    paddingHorizontal: 8,
  },
  customerAvatar: {
    alignItems: 'center',
    backgroundColor: colors.goldSoft,
    borderRadius: 8,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  customerAvatarText: {
    color: colors.gold,
    fontWeight: '900',
  },
  customerDetails: {
    flex: 1,
  },
  customerName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  customerMeta: {
    color: colors.muted,
    marginTop: 3,
  },
  customerAmount: {
    color: colors.greenDark,
    fontWeight: '900',
  },
  paymentRow: {
    alignItems: 'flex-start',
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  paymentMain: {
    flex: 1,
    gap: 4,
  },
  paymentAmount: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  paymentMeta: {
    color: colors.muted,
    fontSize: 13,
  },
  paymentSide: {
    alignItems: 'flex-end',
    gap: 4,
    maxWidth: 150,
  },
  paymentMethod: {
    color: colors.greenDark,
    fontSize: 13,
    fontWeight: '900',
  },
  paymentReference: {
    color: colors.muted,
    fontSize: 12,
  },
  modalOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(23, 33, 28, 0.45)',
    flex: 1,
    justifyContent: 'center',
    padding: 18,
  },
  modalPanel: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: '78%',
    maxWidth: 520,
    padding: 16,
    width: '100%',
  },
  modalHeader: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 12,
  },
  modalTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '900',
  },
  modalMeta: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 3,
  },
  modalList: {
    marginTop: 8,
  },
  modalListContent: {
    paddingBottom: 4,
  },
  closeButton: {
    backgroundColor: colors.softGreen,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  closeButtonText: {
    color: colors.greenDark,
    fontSize: 13,
    fontWeight: '900',
  },
  reportHeader: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  reportTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '900',
  },
  reportMeta: {
    color: colors.muted,
    fontSize: 14,
  },
  reportTable: {
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  reportTableRow: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    minHeight: 44,
  },
  reportTableHeader: {
    backgroundColor: colors.softGreen,
    borderTopWidth: 0,
  },
  reportCell: {
    color: colors.ink,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  reportNumberCell: {
    flex: 0.45,
  },
  reportNameCell: {
    flex: 1.2,
  },
  bottomNav: {
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    bottom: 18,
    flexDirection: 'row',
    gap: 6,
    left: 16,
    maxWidth: 488,
    padding: 6,
    position: 'absolute',
    right: 16,
  },
  navItem: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
  },
  navItemActive: {
    backgroundColor: colors.greenDark,
  },
  navLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  navLabelActive: {
    color: '#ffffff',
  },
});
