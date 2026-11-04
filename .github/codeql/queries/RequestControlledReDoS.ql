/**
 * @name Request data reaches a vulnerable regular expression
 * @description Request-controlled text is matched against a regular expression with exponential backtracking behavior.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.5
 * @precision high
 * @id aihub/request-controlled-redos
 * @tags security external/cwe/cwe-1333 external/cwe/cwe-400
 */

import javascript
import semmle.javascript.frameworks.HTTP
private import semmle.javascript.security.regexp.RegExpTreeView::RegExpTreeView as TreeView
import codeql.regex.nfa.ExponentialBackTracking::Make<TreeView>

module ReDoSConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source instanceof Http::RequestInputAccess
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::CallNode call, RegExpTerm term, string pump, State state, string message |
      call.getCalleeName() = ["test", "exec"] and
      sink = call.getArgument(0) and
      hasReDoSResult(term, pump, state, message) and
      term.getLiteral().flow().(DataFlow::SourceNode).flowsTo(call.getReceiver())
    )
  }

  predicate isBarrier(DataFlow::Node node) { none() }
}

module ReDoSFlow = TaintTracking::Global<ReDoSConfig>;
import ReDoSFlow::PathGraph

from ReDoSFlow::PathNode source, ReDoSFlow::PathNode sink
where ReDoSFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Request-controlled text reaches a regular expression with exponential backtracking behavior."
