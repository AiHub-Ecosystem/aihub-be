# Brief UI: Cập nhật trang hướng dẫn tích hợp AIHUB

> Tài liệu handoff nội bộ cho team Frontend. Đây là brief về cấu trúc và hành vi của trang, không phải nội dung hiển thị nguyên văn cho khách hàng.

## 1. Mục tiêu

Xây dựng một trang tài liệu giúp kỹ sư tích hợp backend của họ với AIHUB có thể:

1. Chọn đúng cách gửi danh tính người dùng mà không nghĩ rằng JWKS luôn bắt buộc.
2. Tạo được request đầu tiên trên environment đúng bằng API key và `X-User-Identity` phù hợp.
3. Tìm được schema chính xác cho từng endpoint.
4. Hiểu cách retry, timeout, xử lý lỗi và giới hạn của Sandbox.

Trang cần phục vụ kỹ sư mới tích hợp. Tra cứu sâu một endpoint hoặc mã lỗi thuộc API Reference của từng sản phẩm, không nhồi toàn bộ schema vào trang hướng dẫn chung. Ưu tiên nội dung kỹ thuật có thể quét nhanh, không làm trang thành landing page quảng bá sản phẩm.

## 2. Đối tượng, route và ranh giới

**Đối tượng chính:** kỹ sư tích hợp gọi AIHUB từ backend của tổ chức mình.

**Luồng cần hỗ trợ:** kỹ sư đọc hướng dẫn, lấy API key qua control plane của AIHUB, cấu hình backend của họ, rồi gọi API AIHUB. Learner cuối cùng không gọi AIHUB trực tiếp.

### Các bề mặt tài liệu đã có trong AIHub Web

| Route                                           | Vai trò hiện tại                                                                                     | Vai trò trong thay đổi này                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/docs`                                         | Hướng dẫn tích hợp chung, hiện là trang tuyến tính nhiều bước với curl/Node.js, lỗi và liên kết tiếp | **Route cần cập nhật.** Thay nội dung cũ bằng luồng đúng theo backend guide; không tạo route docs thứ hai |
| `/product`                                      | Danh mục các sản phẩm API                                                                            | Đích để người đọc chọn sản phẩm và tiếp tục tra cứu                                                       |
| `/product/{product}`                            | Tổng quan sản phẩm, các bước tích hợp, danh sách endpoint                                            | Giữ chi tiết theo từng sản phẩm tại đây                                                                   |
| `/product/{product}/api/{endpoint}`             | Request fields, ví dụ request/response, ghi chú và lỗi của endpoint                                  | API Reference chi tiết; trang `/docs` chỉ tóm tắt và dẫn link tới đây                                     |
| `/console/orgs/{org}/api-keys/{key}/quickstart` | Quickstart động theo API key: scope/environment được cấp và các lệnh “Gọi thử” có thể copy           | Không nhân đôi sample request theo key ở trang docs công khai                                             |
| `/demo`                                         | Trải nghiệm demo riêng của AIHub                                                                     | Không đồng nhất với customer Sandbox hoặc luồng tích hợp thật                                             |

`/docs` trong AIHub Web là trang React tại `AiHub-Frontend/app/docs/page.tsx`. Backend cũng có route `/docs`, nhưng đó là Scalar API Reference trên backend host; hai URL này khác host và khác vai trò. Khi liên kết từ AIHub Web, không dùng nhầm backend `/docs` thay cho `/product`.

Trang này là tài liệu đọc và tra cứu. Không đưa chức năng quản lý tổ chức/API key vào trang docs và không gọi endpoint grading trực tiếp từ trình duyệt. API key của khách hàng chỉ được dùng ở backend của khách hàng. Tái sử dụng cách trình bày và style hiện có của các trang `.aihub`; không dựng thêm một docs shell/navigation system song song nếu chưa có yêu cầu sản phẩm.

## 3. Thông điệp không được sai lệch

Đặt quyết định về identity ở đầu trang, trước phần cấu hình JWT:

| Trạng thái cấu hình Organization       | Giá trị của `X-User-Identity`    | Có cần JWKS không?                              |
| -------------------------------------- | -------------------------------- | ----------------------------------------------- |
| Không có identity configuration active | Declared User ID dạng plain text | Không                                           |
| Có identity configuration active       | Signed User Assertion dạng JWT   | Có; cấu hình JWKS URL hoặc public JWKS document |

Các quy tắc cần giữ nhất quán trên mọi trang, bảng, snippet và API reference:

- Cả bốn grading endpoint hiện tại đều yêu cầu header `X-User-Identity`.
- Header luôn bắt buộc, nhưng giá trị là Declared User ID hoặc Signed User Assertion tùy cấu hình đã lưu cho Organization.
- Không suy ra mode từ hình dạng chuỗi. Organization có identity configuration active phải gửi JWT hợp lệ; plain ID không được fallback.
- Declared User ID không có chữ ký. Người giữ API key có thể gán request cho bất kỳ learner nào trong cùng Organization.
- Chỉ Organization owner mới cấu hình identity verification; cấu hình API dùng AIHUB User Access JWT (Bearer), không dùng Organization API key.
- Một identity configuration áp dụng ở cấp Organization cho các environment của Organization đó.
- API key không được đặt trong browser, mobile app hoặc snippet có giá trị bí mật thật.
- Customer Sandbox và demo assertion sandbox là hai luồng khác nhau; không gộp chúng thành một tính năng.

## 4. Nguồn nội dung và dữ liệu

| Nội dung                                                                     | Nguồn chuẩn                                                                                                                        | Cách dùng trên UI                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Luồng tích hợp, lựa chọn identity, ví dụ, retry, timeout, checklist          | [`integration-guide.md`](integration-guide.md)                                                                                     | Nội dung hướng dẫn và diễn giải cho người dùng                                                                                                                                                  |
| HTTP method/path, auth scheme, headers, request/response schema, status code | OpenAPI runtime được sinh từ `aihub-be/src/contracts/` và `aihub-be/src/catalog/`, phục vụ tại backend `/openapi.json`             | Dùng để xác minh hợp đồng; không chép schema vào trang hướng dẫn chung                                                                                                                          |
| API Reference trên AIHub Web                                                 | `AiHub-Frontend/data/api-products.ts` và `AiHub-Frontend/data/api-reference.ts`; trang được render tại `/product` và các route con | Dẫn link nội bộ tới đúng product/endpoint. Dữ liệu FE hiện là catalog viết trong repo, không phải UI đọc trực tiếp OpenAPI runtime; kiểm tra nó với contract backend trước khi dựa vào chi tiết |
| Backend API Reference                                                        | Backend `/docs` là Scalar, dùng runtime `/openapi.json`                                                                            | Là reference riêng trên backend host; không thay thế route `/product` của AIHub Web và không sửa `openapi.json` artifact bằng tay                                                               |
| Quyết định về identity                                                       | [ADR-0053](adr/0053-optional-user-identity-verification.md) và implementation hiện tại                                             | Dùng để rà soát nội dung, không hiển thị ADR nội bộ cho khách hàng                                                                                                                              |

`openapi.json` trong backend repo là artifact được sinh; không sửa tay để cập nhật giao diện. Runtime `/openapi.json` được dựng từ code đang chạy. AIHub Web hiện giữ nội dung API Reference riêng trong hai file data nêu trên, vì vậy trang `/docs` không nên trở thành bản schema thứ hai. Nếu phát hiện dữ liệu API Reference của FE lệch contract, ghi rõ đó là việc đồng bộ catalog API Reference, không che sai lệch bằng một schema mới trong trang hướng dẫn.

Một số hướng dẫn trong integration guide như timeout, body limit, idempotency, allowance và cách chọn identity là nội dung diễn giải. Không giả định các giá trị này đều có sẵn trong OpenAPI. Nếu render chúng thành dữ liệu UI riêng, ghi nhận rõ nguồn và giữ đồng bộ với backend.

## 5. Cấu trúc nội dung cho route `/docs`

MVP cập nhật trang `/docs` đang có. Trang hiện dùng một cột nội dung, các section tuyến tính (`.aihub-category`), danh sách bước (`.aihub-steps`), facts, callout và code block trong `app/aihub.css`; giữ mô hình này nếu vẫn đọc tốt sau khi thêm nội dung. Không bắt buộc thêm sidebar, search, tab chuyển mode hay một route “Customer Integration” mới. Nếu trang quá dài, ưu tiên mục lục anchor gọn trong cùng trang trước khi thêm navigation system mới.

| Mục điều hướng                   | Nội dung                                                                                          | Mục đích của người đọc                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Mở đầu và chọn identity          | Tóm tắt request flow, bảng so sánh Declared/Signed, nhấn mạnh “JWKS không bắt buộc”               | Biết ngay cách gửi `X-User-Identity` theo cấu hình Organization |
| Quick start                      | Một request Writing Task 2 hợp lệ với Declared User ID; body phải đủ `question`, `topic`, `essay` | Gọi request đầu tiên mà chưa cần dựng JWKS                      |
| Chuẩn bị Organization và API key | Account, Organization, capability/scope, environment, tạo và lưu key                              | Chuẩn bị credential theo luồng thật của Console                 |
| User identity                    | Declared mode trước; Signed mode là phần nâng cao, có config route/owner/JWKS/claims/no fallback  | Chỉ dựng xác minh chữ ký khi Organization bật cấu hình          |
| Chọn API và tra contract         | Tóm tắt bốn grading operation và link đúng product/endpoint trong `/product`                      | Tìm đúng request/response schema đã có                          |
| Sandbox                          | Customer Sandbox và demo assertion sandbox thành hai phần độc lập                                 | Phân biệt sandbox key của khách hàng với demo nội bộ            |
| Reliability                      | Envelope, idempotency, timeout, error/retry và giới hạn                                           | Viết client phía server xử lý được lỗi thực tế                  |
| Checklist và hỗ trợ              | Checklist production, `request_id`, link hỗ trợ                                                   | Hoàn tất rollout và gửi đủ thông tin khi cần trợ giúp           |

### Ánh xạ với tài liệu hiện có

- `integration-guide.md` §§1–1a: Mở đầu, identity decision, quick start.
- §2: Onboarding; đánh dấu rõ phần áp dụng cho mọi Organization và phần chỉ dành cho Signed mode.
- §3: Signed User Assertion, là phần nâng cao/tùy chọn.
- §§3a–3b: Hai sandbox riêng biệt, có heading/callout riêng.
- §4: Bảng bốn grading endpoint; liên kết tới route web tương ứng trong API Reference.
- §§5–8: Response, idempotency, timeout, lỗi, retry.
- §§9–10: Checklist và hỗ trợ.

### Route API Reference tương ứng trên AIHub Web

| Operation            | Route trong AIHub Web                         |
| -------------------- | --------------------------------------------- |
| Writing Task 1       | `/product/scoring/api/grade-task1`            |
| Writing Task 2       | `/product/scoring/api/grade-task2`            |
| Speaking multipart   | `/product/speaking/api/speaking-grading`      |
| Speaking JSON-by-URL | `/product/speaking/api/speaking-grading-json` |

Trước khi publish link Speaking, xác nhận route detail đang có trong build/nhánh FE được triển khai; danh mục FE có product/endpoint, nhưng route detail chỉ được sinh cho endpoint có dữ liệu trong `PRODUCT_DOCS`.

## 6. Bố cục và tương tác

### Điều hướng

- Giữ page chrome, spacing, heading và các section theo style `.aihub` trong `app/aihub.css`; route hiện dùng một cột và chưa có docs sidebar/search riêng.
- Nếu thêm mục lục, dùng link anchor native đến heading trong cùng `/docs`; không tạo sidebar sticky bắt buộc chỉ cho trang này.
- Mọi section cần id ổn định nếu có link trực tiếp; xử lý offset nếu header site che heading đích.
- Navigation hiện có đã nối `/docs` với `/product`, `/demo` và footer; giữ các điểm nối này nhất quán, thêm link API theo product/endpoint thay vì thêm top-level route khác.

### Identity mode

Hiển thị bảng so sánh hai mode đầy đủ ở đầu trang. Theo pattern hiện tại của `/docs`, ưu tiên nội dung tuyến tính và dễ đọc trước; có thể đặt hai snippet riêng thay vì segmented control, để giải thích cả hai mode vẫn hiện diện khi đọc, search hoặc mở anchor.

- Trình bày `Declared User ID` trước và dùng nó cho quick-start cơ bản. Ngay cạnh tên mode ghi “Không cần JWKS”; đây là hướng dẫn mặc định, không phải setting để đổi cấu hình Organization.
- Không ẩn nội dung giải thích của một mode theo trạng thái control: mỗi mode vẫn có section/anchor riêng để đọc, tìm kiếm và deep-link.
- `Signed User Assertion` ghi rõ yêu cầu active identity configuration, owner permission, issuer, một nguồn JWKS, thuật toán và private key ở backend.
- Nếu FE chọn thêm mode switch, nó chỉ đổi sample minh họa, không làm thay đổi cấu hình Organization và không được mô tả như một setting trên trang docs.
- Dù đang chọn mode nào, luôn giải thích rằng backend resolver chọn mode theo cấu hình đã lưu, không theo JWT-looking string.

### Code samples

- Route `/docs` hiện render snippet bằng `<pre className="aihub-code">`; trang API detail có tab Request/Response, còn Quickstart Console có nút copy riêng. Tái sử dụng những pattern đang có; không yêu cầu thêm syntax highlighter hoặc tab ngôn ngữ mới nếu chưa có component chung.
- Code block phải đọc được trên mobile và cuộn ngang khi cần. Nếu thêm nút copy cho public docs, nút cần accessible name, trạng thái đã copy thông báo được cho screen reader, và không làm layout nhảy.
- Dùng ngôn ngữ sample đang có/được duyệt. Không mặc định phải bổ sung Node.js, Python và Java nếu backend guide không cung cấp ví dụ tương ứng.
- Placeholder phải dễ nhận ra, ví dụ `$AIHUB_API_KEY`, `$AIHUB_BASE_URL`, `$USER_IDENTITY`; không có credential thật.
- Snippet Declared mode dùng plain ID. Snippet Signed mode dùng JWT. Ghi rõ biến nào cần được tạo ở server.
- Không cung cấp nút “Send request” hoặc “Try it” gọi grading API từ browser. Request có thể tiêu thụ quota/dispatch và không an toàn để giữ API key trong browser.

### Endpoint reference

Hiển thị bốn grading operation hiện tại:

| Operation            | Method/path                            | Idempotency                | Body limit | AIHUB timeout |
| -------------------- | -------------------------------------- | -------------------------- | ---------- | ------------- |
| Writing Task 1       | `POST /v1/ielts/writing/task1/grade`   | `Idempotency-Key` bắt buộc | 256 KB     | 60 giây       |
| Writing Task 2       | `POST /v1/ielts/writing/task2/grade`   | `Idempotency-Key` bắt buộc | 256 KB     | 60 giây       |
| Speaking multipart   | `POST /v1/ielts/speaking/grading`      | Không hỗ trợ               | 26 MiB     | 60 giây       |
| Speaking JSON-by-URL | `POST /v1/ielts/speaking/grading-json` | Không hỗ trợ               | 256 KB     | 30 giây       |

Các giá trị trên hiện được ghi trong integration guide/operation catalog. Không suy ra `timeout` hoặc `body limit` từ JSON schema nếu OpenAPI chưa xuất chúng.

Mỗi endpoint item nên cho biết method, path, scope, auth headers, content type, identity header, idempotency, body/timeout limits, request schema, response schema và lỗi liên quan. Schema đầy đủ thuộc API Reference; trang hướng dẫn chỉ tóm tắt và liên kết tới đúng operation. `X-User-Identity` luôn required nhưng format tùy identity mode.

`PUT /v1/organizations/{organization_id}/identity-config` là control-plane route dùng Bearer User Access JWT và owner authorization. Đặt nó trong phần Signed mode, không trộn vào danh sách bốn grading endpoints.

## 7. Sandbox: phân biệt hai luồng

### Customer Sandbox

- Dành cho customer Organization keys và chỉ hỗ trợ Writing Task 1/2 với scope `writing.grade`.
- Dùng base URL Sandbox và key riêng; không dùng key production/Sandbox chéo environment. AIHUB hiện không có public staging host.
- Không tính phí khách hàng, nhưng gọi AI service thật và có allowance: tối đa 25 dispatch/Organization/tháng UTC, 500 dispatch toàn Sandbox/tháng UTC.
- Dùng identity configuration của Organization: Declared ID nếu không có config active, Signed assertion nếu có.

### Demo assertion sandbox

- `POST /v1/sandbox/assertions` chỉ dành cho dedicated demo Organization.
- Đây không phải cách mint assertion cho customer Organization.
- Đặt nội dung này dưới “Demo sandbox” riêng; đừng hiện nó như bước bắt buộc để tích hợp customer API.

## 8. Cách trình bày reliability/error

- Response envelope: cho xem `data` là operation-specific và `meta` có request/timing metadata; schema đầy đủ theo OpenAPI.
- Idempotency: nêu rõ chỉ Writing hỗ trợ; cùng key và body để retry; key mới có thể tạo dispatch mới. Speaking không idempotent.
- Timeout: tách Writing 60s, Speaking multipart 60s và Speaking JSON-by-URL 30s. Hướng dẫn client timeout có transit margin; multipart upload chậm có thể cần thêm thời gian.
- Error reference: bảng scan được theo HTTP status/code, nguyên nhân, hành động. Retry theo `retryable`, không branch theo message. Link sang các route `/product/.../api/...`; không copy toàn bộ schema/error catalog vào `/docs`.
- `IDENTITY_PROVIDER_UNAVAILABLE` có thể do config store lỗi ở cả hai mode; lỗi JWKS source liên quan Signed mode. Đừng chỉ hiển thị “JWKS unreachable” như nguyên nhân duy nhất.
- `QUOTA_EXCEEDED`, `RATE_LIMITED`, `CONCURRENCY_LIMIT`, `IDEMPOTENCY_CONFLICT` cần hành động riêng, không gom thành một thông báo “try again”.

## 9. Visual, responsive và accessibility

- Dùng layout và typography sẵn có trong `app/aihub.css` cho `.aihub`; đây là trang developer documentation, ưu tiên hierarchy rõ, độ đọc cao và thông tin dễ scan; không dùng hero marketing lớn.
- Dùng spacing, table, code block và callout nhất quán. Không bọc section trong card trang trí; chỉ dùng khung cho nội dung lặp hoặc công cụ cần phân biệt.
- Desktop giữ chiều rộng dòng đọc được; không cần thêm điều hướng phụ nếu mục lục anchor là đủ. Mobile không có text/code/table tràn khỏi viewport. Bảng có cách cuộn hoặc chuyển cách trình bày có chủ đích.
- Hỗ trợ keyboard cho anchor và các controls thực sự xuất hiện; giữ focus ring rõ.
- Dùng heading theo thứ bậc; mọi tương tác có label/role/state; thông báo copy thành công không chỉ dựa vào màu hoặc icon.
- Contrast đạt chuẩn của design system; không dùng màu đơn lẻ để phân biệt Declared/Signed, success/error hoặc environment.
- Tôn trọng reduced-motion nếu site dùng animation. Trang vẫn usable khi JavaScript của phần tương tác bị lỗi; nội dung cơ bản và link API Reference cần đọc được.

## 10. Bảo mật và quyền riêng tư

- Không đặt API key hoặc private signing key vào HTML, query string, client-side storage, browser logs hoặc analytics.
- Không gửi essay, audio, assertion hoặc API key qua telemetry/copy analytics.
- Ví dụ chỉ chứa dữ liệu giả hoặc placeholder. Không dùng assertion sống trong screenshot/demo.
- Nêu rõ email có thể được lưu và chuyển tiếp như End-User ID; khuyến nghị opaque, stable ID.
- Không dựng browser playground cho grading trong phạm vi này. Nếu sau này có “Try it”, cần một thiết kế backend proxy/sandbox riêng; không để browser gọi bằng customer API key.

## 11. Ngoài phạm vi

- Thay thế API Reference của AIHub Web tại `/product` hoặc backend Scalar/OpenAPI renderer.
- Quản lý Organization, thành viên, API key, identity configuration hoặc quota từ trang docs.
- Cho phép người dùng mint customer assertion bằng demo route.
- Gọi AI grading hoặc tiêu thụ Sandbox quota từ browser.
- Tự định nghĩa schema, error code, scope, timeout, body limit hay quota ngoài contract hiện tại.
- Thêm backend endpoint hoặc thay đổi semantics của identity để phục vụ UI.

## 12. Tiêu chí hoàn thành

- Người đọc mới nhìn thấy ngay: JWKS không bắt buộc; `X-User-Identity` vẫn bắt buộc trên mọi grading request.
- Quick start Declared mode có thể tìm thấy trước phần JWT và request sample hợp lệ với schema hiện hành.
- Signed mode giải thích được owner permission, Bearer control-plane config, đúng một JWKS source và no-fallback behavior.
- Trang `/docs` được cập nhật tại route hiện hữu; không sinh thêm trang integration trùng chức năng.
- Link API Reference dùng route AIHub Web `/product/...`; không nhầm với backend Scalar `/docs`.
- Chi tiết schema trong `/docs` không tạo thành bản sao thứ hai của API Reference; mọi link endpoint dẫn tới đúng trang detail đang được build.
- Bốn grading operation hiển thị đúng path, auth, idempotency, body limit và timeout; route demo mint được phân loại riêng.
- Customer Sandbox và demo sandbox không thể bị nhầm là cùng một luồng.
- Không có API key/private key thật; không có browser action gọi grading.
- Các anchor (nếu có) hoạt động và link không bị header che; code copy (nếu được thêm) có trạng thái accessible.
- Layout dùng được ở desktop và mobile hẹp; keyboard/focus/contrast và overflow được kiểm tra thủ công.
- Nội dung không chứa trạng thái issue/PR/deployment tạm thời như “chờ issue X triển khai”.

## 13. Quyết định cần chốt với FE/Product

Repo FE đã có route và kiến trúc tài liệu; các điểm cần xác nhận trước khi triển khai:

1. Giữ `/docs` làm trang hướng dẫn chung (khuyến nghị) hay chủ trương chuyển nội dung sang product-specific pages.
2. Link bốn grading operation sang `/product/...` như route map ở trên; xác nhận các trang detail Speaking có mặt trong bản deploy.
3. Các hostname production/Sandbox được duyệt để ghi trong public docs; không giả định có public staging host.
4. Public docs có cần nút copy cho code block không; nếu có thì dùng pattern/component nào đang được FE duy trì.
5. Locale: `/docs` hiện viết tiếng Việt; xác nhận có cần tạo bản tiếng Anh hoặc hỗ trợ locale cùng đợt không.

Khuyến nghị mặc định: giữ `/docs` công khai làm workflow/quickstart tổng quát; `/product` tiếp tục là API Reference công khai của AIHub Web; Console Quickstart giữ sample request gắn với từng key. Backend Scalar/OpenAPI là nguồn kiểm chứng contract, không phải mặc định route đích cho link trong website. Hostname phải theo environment đang mô tả; phân biệt production với Customer Sandbox và không gọi Sandbox là staging.

## 14. Tài liệu liên quan

- [Customer Integration Guide](integration-guide.md)
- [OpenAPI 3.1 artifact](../openapi.json) — artifact sinh từ code; runtime source là endpoint `/openapi.json`.
- [ADR-0053: optional end-user identity verification](adr/0053-optional-user-identity-verification.md)
- [ADR-0056: Customer Sandbox](adr/0056-customer-sandbox-test-tier.md)
- FE route hiện tại: `AiHub-Frontend/app/docs/page.tsx`, `AiHub-Frontend/app/product/page.tsx`, `AiHub-Frontend/app/product/[slug]/page.tsx`, `AiHub-Frontend/app/product/[slug]/api/[endpoint]/page.tsx`.
- FE API catalog/reference data: `AiHub-Frontend/data/api-products.ts`, `AiHub-Frontend/data/api-reference.ts`.
- FE theo-key Quickstart: `AiHub-Frontend/app/console/orgs/[organizationId]/api-keys/[apiKeyId]/quickstart/page.tsx` và `AiHub-Frontend/components/organizations/sample-requests.tsx`.
