/**
 * @name Request data reaches an unsafe SQL query
 * @description Request-controlled text reaches Prisma's unsafe raw SQL API.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 9.8
 * @precision high
 * @id aihub/request-data-to-raw-sql
 * @tags security external/cwe/cwe-089
 */

import javascript
import semmle.javascript.frameworks.HTTP

module RawSqlConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source instanceof Http::RequestInputAccess
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::CallNode call |
      call.getCalleeName() = ["$queryRawUnsafe", "$executeRawUnsafe"] and
      sink = call.getArgument(0)
    )
  }

  predicate isBarrier(DataFlow::Node node) { none() }
}

module RawSqlFlow = TaintTracking::Global<RawSqlConfig>;
import RawSqlFlow::PathGraph

from RawSqlFlow::PathNode source, RawSqlFlow::PathNode sink
where RawSqlFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Request-controlled data reaches an unsafe raw SQL query."
