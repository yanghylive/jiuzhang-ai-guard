'use strict';

// The billing API has used several names for the same values over time.
const REMAINING_FIELDS = [
  'SlicePeriodCapacityRemainPrecise',
  'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise',
  'CycleCapacityRemain',
  'CapacityRemainPrecise',
  'CapacityRemain',
  'RemainPrecise',
  'Remain',
  'Remaining',
  'Balance',
];
const TOTAL_FIELDS = [
  'SlicePeriodCapacitySizePrecise',
  'SlicePeriodCapacitySize',
  'CycleCapacitySizePrecise',
  'CycleCapacitySize',
  'CycleCapacityPrecise',
  'CycleCapacity',
  'CapacityPrecise',
  'Capacity',
  'TotalCapacityPrecise',
  'TotalCapacity',
  'PackageCapacity',
  'Quota',
  'Amount',
];
const EXPIRY_FIELDS = [
  'DeductionEndTime',
  'ExpiredTime',
  'SlicePeriodEndTime',
  'PackageEndTime',
  'EndTime',
  'CycleEndTime',
  'ExpireTime',
  'ExpirationTime',
  'ValidEndTime',
  'ValidPeriodEndTime',
  'EndAt',
  'ExpireAt',
];
const LABEL_FIELDS = [
  'PackageName',
  'PackageTypeName',
  'AccountName',
  'ProductName',
  'Name',
  'RuleName',
  'Description',
];

function firstNumber(value, fields) {
  for (const field of fields) {
    const raw = value && value[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(value, fields) {
  for (const field of fields) {
    const parsed = parseTimestamp(value && value[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstText(value, fields) {
  for (const field of fields) {
    const text = value && value[field];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function extractCreditSegments(accounts, source) {
  return (Array.isArray(accounts) ? accounts : [])
    .flatMap((account) => {
      const details = Array.isArray(account && account.SlicePeriodUsageDetails) && account.SlicePeriodUsageDetails.length
        ? account.SlicePeriodUsageDetails.map((detail) => Object.assign({}, account, detail))
        : [account];
      return details.map((item) => {
        const remaining = firstNumber(item, REMAINING_FIELDS);
        if (remaining === null || remaining <= 0) return null;
        const total = firstNumber(item, TOTAL_FIELDS);
        return {
          remaining: Number(remaining.toFixed(2)),
          total: Number((total === null ? remaining : Math.max(total, remaining)).toFixed(2)),
          expiresAt: firstTimestamp(item, EXPIRY_FIELDS),
          source: firstText(item, LABEL_FIELDS) || source || '积分',
        };
      });
    })
    .filter(Boolean);
}

function sortCreditSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && Number(segment.remaining) > 0)
    .map((segment) => ({
      remaining: Number(Number(segment.remaining).toFixed(2)),
      total: Number(Number(segment.total || segment.remaining).toFixed(2)),
      expiresAt: segment.expiresAt === null || segment.expiresAt === undefined ? null : Number(segment.expiresAt),
      source: String(segment.source || '积分'),
    }))
    .sort((a, b) => {
      if (a.expiresAt === null && b.expiresAt !== null) return 1;
      if (a.expiresAt !== null && b.expiresAt === null) return -1;
      return (a.expiresAt || 0) - (b.expiresAt || 0);
    });
}

module.exports = { extractCreditSegments, sortCreditSegments };
