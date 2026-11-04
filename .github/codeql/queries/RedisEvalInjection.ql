/**
 * @name Request data reaches a Redis eval script
 * @description Request-controlled text reaches the first argument of Redis eval.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 8.8
 * @precision high
 * @id aihub/request-data-to-redis-eval
 * @tags security external/cwe/cwe-094
 */

import javascript
import semmle.javascript.frameworks.HTTP

module RedisEvalConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source instanceof Http::RequestInputAccess
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::CallNode call |
      call.getCalleeName() = "eval" and
      sink = call.getArgument(0)
    )
  }

  predicate isBarrier(DataFlow::Node node) { none() }
}

module RedisEvalFlow = TaintTracking::Global<RedisEvalConfig>;
import RedisEvalFlow::PathGraph

from RedisEvalFlow::PathNode source, RedisEvalFlow::PathNode sink
where RedisEvalFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Request-controlled data reaches a Redis eval script."
