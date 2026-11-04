/**
 * @name Request data reaches an S3 object key
 * @description Request-controlled text determines an object key sent to S3.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.5
 * @precision high
 * @id aihub/request-data-to-s3-key
 * @tags security external/cwe/cwe-639
 */

import javascript
import semmle.javascript.frameworks.HTTP

module S3ObjectKeyConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source instanceof Http::RequestInputAccess
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::InvokeNode call |
      call.getCalleeName() = ["PutObjectCommand", "CopyObjectCommand", "DeleteObjectCommand", "GetObjectCommand", "HeadObjectCommand", "putObject"] and
      sink = call.getOptionArgument(0, "Key")
    )
  }

  predicate isBarrier(DataFlow::Node node) { none() }
}

module S3ObjectKeyFlow = TaintTracking::Global<S3ObjectKeyConfig>;
import S3ObjectKeyFlow::PathGraph

from S3ObjectKeyFlow::PathNode source, S3ObjectKeyFlow::PathNode sink
where S3ObjectKeyFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Request-controlled data determines an S3 object key."
