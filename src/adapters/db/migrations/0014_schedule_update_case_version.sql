-- 0013: 勤務表更新に、準備を始めた時点の案件版を持たせる。担当A（Day 2）。
--
-- D08：正式採用の直前に案件版を再検査する。0007 の schedule_update は案件版を
-- 持っていなかったため、「選定してから案件が動いていないか」を版で照合できなかった。
-- selection_result.case_version は**検査した時点**（COORDINATING）の版で、準備開始の
-- 遷移（COORDINATING -> PREPARING）で1つ進むため、そのままでは比較できない。
--
-- ここに入れるのは準備開始**後**の版。採用取引で案件行をロックして読んだ版がこれと
-- 違えば、その間に停止・照合・訂正など別の変更が入っている（A04・A05）。

alter table schedule_update add column case_version integer not null default 0;
alter table schedule_update alter column case_version drop default;
