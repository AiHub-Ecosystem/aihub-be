/**
 * @name Request data reaches a log call
 * @description Request-controlled data may expose credentials, assertions, essay text, or raw bodies in logs.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.5
 * @precision high
 * @id aihub/request-data-to-log
 * @tags security external/cwe/cwe-532
 */

import javascript
import semmle.javascript.frameworks.HTTP
import semmle.javascript.heuristics.AdditionalSources

module SensitiveLoggingConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source instanceof Http::RequestInputAccess or
    source instanceof RemoteServerResponse
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::CallNode call |
      call.getCalleeName() = ["log", "info", "warn", "error", "debug", "trace", "fatal", "verbose", "silly"] and
      sink = call.getAnArgument()
    )
  }

  predicate isBarrier(DataFlow::Node node) { none() }
}

module SensitiveLoggingFlow = TaintTracking::Global<SensitiveLoggingConfig>;
import SensitiveLoggingFlow::PathGraph

from SensitiveLoggingFlow::PathNode source, SensitiveLoggingFlow::PathNode sink
where SensitiveLoggingFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Request-controlled data reaches a log call."
