export type PlanNode = {
  readonly 'Node Type'?: string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Actual Total Time'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly 'Temp Read Blocks'?: number;
  readonly 'Temp Written Blocks'?: number;
  readonly 'Sort Method'?: string;
  readonly 'Sort Space Type'?: string;
  readonly 'Sort Space Used'?: number;
  readonly 'Heap Fetches'?: number;
  readonly 'Index Cond'?: string;
  readonly Filter?: string;
  readonly Output?: readonly string[];
  readonly 'Conflict Arbiter Indexes'?: readonly string[];
  readonly Plans?: readonly PlanNode[];
};

export interface PlanDocument {
  readonly Plan: PlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
}

export interface BaselineQuery {
  readonly name: string;
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly tables: readonly string[];
  readonly expectedIndexes: readonly string[];
  readonly expectedSeqScanTables?: readonly string[];
  readonly mutates?: boolean;
}

export interface TableSize {
  readonly rows: string;
  readonly tableBytes: string;
  readonly indexBytes: string;
  readonly totalBytes: string;
  readonly createdAtCorrelation: string;
}
