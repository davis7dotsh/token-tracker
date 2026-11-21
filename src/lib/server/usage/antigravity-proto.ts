const decoder = new TextDecoder();

export type BlobSliceReader = {
  readonly length: number;
  read(offset: number, length: number): Uint8Array | null;
};

export const memoryBlobReader = (bytes: Uint8Array): BlobSliceReader => ({
  length: bytes.length,
  read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > bytes.length) return null;
    return bytes.subarray(offset, offset + length);
  },
});

const MAX_STRING_BYTES = 4096;
const MAX_PACKED_STEP_BYTES = 65_536;

type VarintResult = { value: bigint; next: number };

const readVarintFromReader = (reader: BlobSliceReader, start: number, end: number): VarintResult | null => {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < end) {
    const slice = reader.read(offset, 1);
    if (!slice || slice.length !== 1) return null;
    const byte = slice[0];
    offset++;
    if (shift === 63n) {
      if ((byte & 0xfe) !== 0) return null;
      value |= BigInt(byte & 0x01) << 63n;
      return { value, next: offset };
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7n;
  }
  return null;
};

const readVarintFromBuffer = (bytes: Uint8Array, start: number): VarintResult | null => {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    // Standard 64-bit protobuf varints take at most 10 bytes; byte 10 carries
    // only bit 0 (and must terminate with MSB = 0).
    if (shift === 63n) {
      if ((byte & 0xfe) !== 0) return null;
      value |= BigInt(byte & 0x01) << 63n;
      return { value, next: offset };
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7n;
  }
  return null;
};

const safeCount = (value: bigint) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
};

const signedInt64 = (value: bigint) => (value >= 1n << 63n ? value - (1n << 64n) : value);

type VisitedField =
  | { readonly field: number; readonly wireType: 0; readonly value: bigint }
  | { readonly field: number; readonly wireType: 2; readonly start: number; readonly end: number };

// Walks a protobuf message range on a BlobSliceReader by reading only exact
// tag and length varint bytes. Non-allowlisted length-delimited fields are
// skipped purely by offset arithmetic so zero excluded payload bytes ever enter JS memory.
const walkFields = (
  reader: BlobSliceReader,
  start: number,
  end: number,
  onField: (item: VisitedField) => boolean | void,
): boolean => {
  if (start < 0 || end < start || end > reader.length) return false;
  let offset = start;
  while (offset < end) {
    const tag = readVarintFromReader(reader, offset, end);
    if (!tag) return false;
    const fieldBig = tag.value >> 3n;
    if (fieldBig <= 0n || fieldBig > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const field = Number(fieldBig);
    const wireType = Number(tag.value & 7n);
    offset = tag.next;

    if (wireType === 0) {
      const value = readVarintFromReader(reader, offset, end);
      if (!value) return false;
      offset = value.next;
      if (onField({ field, wireType: 0, value: value.value }) === false) return false;
    } else if (wireType === 1) {
      if (offset + 8 > end) return false;
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarintFromReader(reader, offset, end);
      if (!length || length.value < 0n || length.value > BigInt(end - length.next)) return false;
      const payloadStart = length.next;
      const payloadEnd = payloadStart + Number(length.value);
      offset = payloadEnd;
      if (onField({ field, wireType: 2, start: payloadStart, end: payloadEnd }) === false) return false;
    } else if (wireType === 5) {
      if (offset + 4 > end) return false;
      offset += 4;
    } else {
      return false;
    }
  }
  return true;
};

const readStringSlice = (reader: BlobSliceReader, start: number, end: number, maxBytes = MAX_STRING_BYTES) => {
  const size = end - start;
  if (size <= 0 || size > maxBytes) return size === 0 ? '' : null;
  const bytes = reader.read(start, size);
  if (!bytes || bytes.length !== size) return null;
  return decoder.decode(bytes).trim();
};

const readPackedVarintsSlice = (reader: BlobSliceReader, start: number, end: number) => {
  const size = end - start;
  if (size <= 0 || size > MAX_PACKED_STEP_BYTES) return size === 0 ? [] : null;
  const bytes = reader.read(start, size);
  if (!bytes || bytes.length !== size) return null;
  const values: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const next = readVarintFromBuffer(bytes, offset);
    if (!next) return null;
    offset = next.next;
    const count = safeCount(next.value);
    if (count === null) return null;
    values.push(count);
  }
  return values;
};

const decodeTimestampSlice = (reader: BlobSliceReader, start: number, end: number): string => {
  if (end < start) return '';
  if (end === start) return '1970-01-01T00:00:00.000Z';
  let seconds = 0n;
  let nanos = 0n;
  const ok = walkFields(reader, start, end, (item) => {
    if (item.wireType !== 0) return;
    if (item.field === 1) seconds = signedInt64(item.value);
    else if (item.field === 2) nanos = signedInt64(item.value);
  });
  if (!ok || nanos < 0n || nanos >= 1_000_000_000n) return '';
  const millisBig = seconds * 1000n + nanos / 1_000_000n;
  if (millisBig < -8_640_000_000_000_000n || millisBig > 8_640_000_000_000_000n) return '';
  const date = new Date(Number(millisBig));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

export type AntigravityModelUsage = {
  modelEnum: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  thinkingOutputTokens: number;
  responseOutputTokens: number;
  messageId: string;
  responseId: string;
  providerAssignedMessageId: string;
  serviceTier: string;
};

export const decodeModelUsageStatsRange = (
  reader: BlobSliceReader,
  start = 0,
  end = reader.length,
): AntigravityModelUsage | null => {
  const usage: AntigravityModelUsage = {
    modelEnum: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    messageId: '',
    responseId: '',
    providerAssignedMessageId: '',
    serviceTier: '',
  };
  const ok = walkFields(reader, start, end, (item) => {
    if (item.wireType === 0) {
      if (
        item.field !== 1 &&
        item.field !== 2 &&
        item.field !== 3 &&
        item.field !== 4 &&
        item.field !== 5 &&
        item.field !== 9 &&
        item.field !== 10
      )
        return;
      const value = safeCount(item.value);
      if (value === null) return false;
      if (item.field === 1) usage.modelEnum = value;
      else if (item.field === 2) usage.inputTokens = value;
      else if (item.field === 3) usage.outputTokens = value;
      else if (item.field === 4) usage.cacheWriteTokens = value;
      else if (item.field === 5) usage.cacheReadTokens = value;
      else if (item.field === 9) usage.thinkingOutputTokens = value;
      else if (item.field === 10) usage.responseOutputTokens = value;
    } else if (item.wireType === 2) {
      if (item.field === 7) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value === null) return false;
        usage.messageId = value;
      } else if (item.field === 11) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value === null) return false;
        usage.responseId = value;
      } else if (item.field === 12) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value === null) return false;
        usage.providerAssignedMessageId = value;
      } else if (item.field === 13) {
        const value = readStringSlice(reader, item.start, item.end, 128);
        if (value === null) return false;
        usage.serviceTier = value;
      }
    }
  });
  return ok ? usage : null;
};

export const decodeModelUsageStats = (bytes: Uint8Array) => decodeModelUsageStatsRange(memoryBlobReader(bytes));

export type AntigravityGeneratorMetadata = {
  modelEnum: number;
  responseModel: string;
  responseModelFull: string;
  plannerModelName: string;
  usage: AntigravityModelUsage | null;
  stepIndices: number[];
  executionId: string;
};

// Allowlist only accounting, model, step-index, and execution fields.
// Prompt fields on ChatModelMetadata (system_prompt, message_prompts,
// prompt_debug_str) are skipped by offset and never read from SQLite.
export const decodeGeneratorMetadataFromReader = (reader: BlobSliceReader): AntigravityGeneratorMetadata | null => {
  const result: AntigravityGeneratorMetadata = {
    modelEnum: 0,
    responseModel: '',
    responseModelFull: '',
    plannerModelName: '',
    usage: null,
    stepIndices: [],
    executionId: '',
  };
  const ok = walkFields(reader, 0, reader.length, (item) => {
    if (item.field === 1 && item.wireType === 2) {
      return walkFields(reader, item.start, item.end, (entry) => {
        if (entry.field === 3 && entry.wireType === 0) {
          const modelEnum = safeCount(entry.value);
          if (modelEnum !== null) result.modelEnum = modelEnum;
        } else if (entry.field === 4 && entry.wireType === 2) {
          result.usage = decodeModelUsageStatsRange(reader, entry.start, entry.end);
          if (!result.usage) return false;
        } else if (entry.field === 19 && entry.wireType === 2) {
          const value = readStringSlice(reader, entry.start, entry.end, 512);
          if (value === null) return false;
          result.responseModel = value;
        } else if (entry.field === 22 && entry.wireType === 2) {
          const value = readStringSlice(reader, entry.start, entry.end, 512);
          if (value === null) return false;
          result.responseModelFull = value;
        }
      });
    }
    if (item.field === 2 && item.wireType === 2) {
      const packed = readPackedVarintsSlice(reader, item.start, item.end);
      if (!packed) return false;
      result.stepIndices.push(...packed);
    } else if (item.field === 2 && item.wireType === 0) {
      const index = safeCount(item.value);
      if (index === null) return false;
      result.stepIndices.push(index);
    } else if (item.field === 3 && item.wireType === 2) {
      walkFields(reader, item.start, item.end, (entry) => {
        if (entry.field === 28 && entry.wireType === 2) {
          const value = readStringSlice(reader, entry.start, entry.end, 512);
          if (value !== null) result.plannerModelName = value;
        }
      });
    } else if (item.field === 4 && item.wireType === 2) {
      const value = readStringSlice(reader, item.start, item.end, 512);
      if (value !== null) result.executionId = value;
    }
  });
  return ok ? result : null;
};

export const decodeGeneratorMetadata = (bytes: Uint8Array) =>
  decodeGeneratorMetadataFromReader(memoryBlobReader(bytes));

export type AntigravityStepMetadata = {
  createdAt: string;
  completedAt: string;
  finishedGeneratingAt: string;
  startedAt: string;
  modelUsage: AntigravityModelUsage | null;
  malformedUsage: boolean;
  generatorModelEnum: number;
  executionId: string;
};

// Only timestamps, usage counters, model enum, and execution ID are read from
// step metadata. Tool-call arguments and all other fields are skipped by offset.
export const decodeStepMetadataFromReader = (reader: BlobSliceReader): AntigravityStepMetadata | null => {
  const result: AntigravityStepMetadata = {
    createdAt: '',
    completedAt: '',
    finishedGeneratingAt: '',
    startedAt: '',
    modelUsage: null,
    malformedUsage: false,
    generatorModelEnum: 0,
    executionId: '',
  };
  const ok = walkFields(reader, 0, reader.length, (item) => {
    if (item.wireType === 2) {
      if (item.field === 1) result.createdAt = decodeTimestampSlice(reader, item.start, item.end);
      else if (item.field === 7) result.finishedGeneratingAt = decodeTimestampSlice(reader, item.start, item.end);
      else if (item.field === 8) result.completedAt = decodeTimestampSlice(reader, item.start, item.end);
      else if (item.field === 9) {
        const usage = decodeModelUsageStatsRange(reader, item.start, item.end);
        if (usage) result.modelUsage = usage;
        else result.malformedUsage = true;
      } else if (item.field === 12) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value !== null) result.executionId = value;
      } else if (item.field === 32) result.startedAt = decodeTimestampSlice(reader, item.start, item.end);
    } else if (item.wireType === 0 && item.field === 11) {
      const modelEnum = safeCount(item.value);
      if (modelEnum !== null) result.generatorModelEnum = modelEnum;
    }
  });
  return ok ? result : null;
};

export const decodeStepMetadata = (bytes: Uint8Array) => decodeStepMetadataFromReader(memoryBlobReader(bytes));

export type AntigravityWorkspace = {
  folderUri: string;
  gitRootUri: string;
  remoteUrl: string;
  branchName: string;
};

export type AntigravityTrajectoryMetadata = {
  workspaces: AntigravityWorkspace[];
  workspaceUris: string[];
  createdAt: string;
  parentConversationId: string;
  rootConversationId: string;
  subagentRole: string;
  nestingDepth: number;
};

// Only workspace metadata, timestamps, parent IDs, nesting depth, and subagent
// role label are read. Any initial prompt on subagent_spec is skipped by offset.
export const decodeTrajectoryMetadataFromReader = (reader: BlobSliceReader): AntigravityTrajectoryMetadata | null => {
  const result: AntigravityTrajectoryMetadata = {
    workspaces: [],
    workspaceUris: [],
    createdAt: '',
    parentConversationId: '',
    rootConversationId: '',
    subagentRole: '',
    nestingDepth: 0,
  };
  const ok = walkFields(reader, 0, reader.length, (item) => {
    if (item.wireType === 2) {
      if (item.field === 1) {
        const workspace: AntigravityWorkspace = { folderUri: '', gitRootUri: '', remoteUrl: '', branchName: '' };
        const wsOk = walkFields(reader, item.start, item.end, (entry) => {
          if (entry.wireType !== 2) return;
          if (entry.field === 1) {
            const value = readStringSlice(reader, entry.start, entry.end);
            if (value !== null) workspace.folderUri = value;
          } else if (entry.field === 2) {
            const value = readStringSlice(reader, entry.start, entry.end);
            if (value !== null) workspace.gitRootUri = value;
          } else if (entry.field === 3) {
            walkFields(reader, entry.start, entry.end, (repoEntry) => {
              if (repoEntry.field === 2 && repoEntry.wireType === 2) {
                const value = readStringSlice(reader, repoEntry.start, repoEntry.end);
                if (value !== null) workspace.remoteUrl = value;
              }
            });
          } else if (entry.field === 4) {
            const value = readStringSlice(reader, entry.start, entry.end, 512);
            if (value !== null) workspace.branchName = value;
          }
        });
        if (wsOk) result.workspaces.push(workspace);
      } else if (item.field === 2) {
        result.createdAt = decodeTimestampSlice(reader, item.start, item.end);
      } else if (item.field === 5) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value !== null) result.parentConversationId = value;
      } else if (item.field === 6) {
        const value = readStringSlice(reader, item.start, item.end, 512);
        if (value !== null) result.rootConversationId = value;
      } else if (item.field === 7) {
        const uri = readStringSlice(reader, item.start, item.end);
        if (uri) result.workspaceUris.push(uri);
      } else if (item.field === 8) {
        walkFields(reader, item.start, item.end, (entry) => {
          if (entry.field === 2 && entry.wireType === 2) {
            const value = readStringSlice(reader, entry.start, entry.end, 1024);
            if (value !== null) result.subagentRole = value;
          }
        });
      }
    } else if (item.wireType === 0 && item.field === 17) {
      const depth = safeCount(item.value);
      if (depth !== null) result.nestingDepth = depth;
    }
  });
  return ok ? result : null;
};

export const decodeTrajectoryMetadata = (bytes: Uint8Array) =>
  decodeTrajectoryMetadataFromReader(memoryBlobReader(bytes));

export type AntigravityExecutorMetadata = {
  executionId: string;
  modelName: string;
};

export const decodeExecutorMetadataFromReader = (reader: BlobSliceReader): AntigravityExecutorMetadata => {
  const result: AntigravityExecutorMetadata = { executionId: '', modelName: '' };
  walkFields(reader, 0, reader.length, (item) => {
    if (item.wireType !== 2) return;
    if (item.field === 9) {
      const value = readStringSlice(reader, item.start, item.end, 512);
      if (value !== null) result.executionId = value;
    } else if (item.field === 10) {
      walkFields(reader, item.start, item.end, (inner) => {
        if (inner.field !== 1 || inner.wireType !== 2) return;
        walkFields(reader, inner.start, inner.end, (entry) => {
          if (entry.field === 28 && entry.wireType === 2) {
            const value = readStringSlice(reader, entry.start, entry.end, 512);
            if (value) result.modelName = value;
          }
        });
      });
    }
  });
  return result;
};
