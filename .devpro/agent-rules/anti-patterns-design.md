---
name: anti-patterns-design
description: Design / over-reach anti-patterns（§1-§6：drive-by refactor、silent assumption、premature abstraction、defensive-without-evidence、fix-without-reproduce、name drift）+ antidotes。觸發：考慮重構/抽象/防禦碼/改名/修 bug 時對照。
---

# Design Anti-Patterns（§1-§6）

> Load-chain：本檔由 `anti-patterns-examples.md` 按需載入；entry leaf 只保留 pattern 索引，§1-§6 detail 在此。

### §1 Drive-by Refactor（順手改旁邊）

**請求**：「修 `ValidateUser` 空 email crash 的 bug」

❌ 順手強化驗證、加 username 長度、補註解——全不在 scope：

```csharp
var email = user.Email?.Trim() ?? string.Empty;
if (string.IsNullOrEmpty(email)) throw new ArgumentException("Email required");
if (!email.Contains('@') || !email.Split('@')[1].Contains('.')) throw ...;
if (string.IsNullOrEmpty(user.Username?.Trim())) throw ...;
if (user.Username.Length < 3) throw new ArgumentException("Username too short");
```

✅ 只改 `null` → `IsNullOrWhiteSpace`，其他行不動：

```csharp
if (string.IsNullOrWhiteSpace(user.Email)) throw new ArgumentException("Email required");
if (!user.Email.Contains('@')) throw new ArgumentException("Invalid email");
if (user.Username == null) throw new ArgumentException("Username required");
```

**每一行變更是否能追溯回「空 email crash」？✅ 才能送出。**

### §2 Silent Assumption（沒問就假設需求）

**請求**：「加一個匯出使用者資料的功能」

❌ 默默假設匯出全部 / CSV / 直接下載 / 固定欄位。  
✅ 先問清楚：範圍（含不含 PII）、格式（CSV/JSON）、規模（是否 background job）、欄位（Role/CreatedAt/敏感欄位）。確認後再動手。

### §3 Premature Abstraction（過早抽象）

**請求**：「加一個計算折扣的 function」

❌ 直接上 Strategy Pattern（介面 + 兩個實作 + calculator）。

```csharp
// ✅ 先一個 function，有第二種算法出現時再抽
public static decimal CalculateDiscount(decimal amount, decimal pct)
    => amount * (pct / 100);
```

現在就抽象 = 為不存在的需求付維護成本。

### §4 Defensive Without Evidence（沒證據就防禦）

**請求**：「修 `GetUserName(id=0)` 回傳 null」

```csharp
// ❌ 後三條無「framework 沒處理」的證據
if (id <= 0) return null;
if (_db.Users.Find(id) == null) return null;   // EF 已處理
if (user.Profile == null) return null;          // 無證據
if (user.Profile.Name == null) return null;     // 無證據
return user.Profile.Name.Trim();                // 順手 Trim

// ✅ 只防禦有證據的情境
if (id <= 0) return null;
return _db.Users.Find(id)?.Profile?.Name;
```

若要加 Trim，先確認是否有「Name 前後空白」的實際 bug。

### §5 Fix-Without-Reproduce-Test（沒重現測試就修）

**請求**：「排行榜分數相同時順序跳動」

❌ 直接改實作，無法證明「修前 fail / 修後 pass」。✅ Prove-it pattern：

```csharp
[Fact]
public void SortScores_WithDuplicates_StableByName() {
    var input = new[] {
        new Score("Alice", 100), new Score("Bob", 100), new Score("Chris", 90)
    }.ToList();
    for (int i = 0; i < 10; i++) {
        var result = SortScores(input);
        Assert.Equal("Alice", result[0].Name);
        Assert.Equal("Bob",   result[1].Name);
    }
}
// 跑 → 確認 fail → 改實作 → 再跑 → pass
```

規則連動：`testing-and-qa.md`「Bug 修復 Prove-It Pattern（強制）」。

### §6 Name Drift（順手改名）

**請求**：「修 `calcTotl` 計算錯誤的 bug」

```csharp
// ❌ 改名 + 改型別 + bug fix 混在一起，所有 caller 跟著動
public decimal CalculateTotal(IReadOnlyList<Item> items)
    => items.Sum(i => i.Price * i.Qty * (1 - i.DiscountRate));

// ✅ 只修 bug，改名另開 chore/ PR
public decimal calcTotl(List<Item> items)
    => items.Sum(i => i.Price * i.Qty * (1 - i.DiscountRate));
```

例外：改名本身是 bug 根因時，才可在同 PR 內改名並說明。
