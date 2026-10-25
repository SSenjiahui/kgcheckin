import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";

/**
 * 领取一次 VIP，带自动重试。
 * 酷狗接口偶发返回 30000（服务端繁忙/风控），这类错误重试几次通常就过了；
 * 30002 表示「今日次数已用光」，属于正常终止条件，不重试。
 */
async function claimVip(headers, maxRetry = 2) {
  let last = null
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const resp = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers)
    last = resp
    if (resp.status === 1) return { ok: true, exhausted: false, resp }
    if (resp.error_code === 30002) return { ok: false, exhausted: true, resp }
    if (attempt < maxRetry) {
      const waitMs = 5000 * (attempt + 1)
      printYellow(`领取返回异常(${resp.error_code ?? '未知'})，${waitMs / 1000}s 后重试...`)
      await delay(waitMs)
    }
  }
  return { ok: false, exhausted: false, resp: last }
}

async function main() {

  const USERINFO = process.env.USERINFO
  // 刷新token
  let needRefresh = false
  if (!USERINFO) {
    throw new Error("未配置")
  }
  const userinfo = JSON.parse(USERINFO)

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  const today = new Date();
  // 服务器时间比国内慢8小时
  today.setTime(today.getTime() + 8 * 60 * 60 * 1000)
  //日期
  const DD = String(today.getDate()).padStart(2, '0'); // 获取日
  const MM = String(today.getMonth() + 1).padStart(2, '0'); //获取月份，1 月为 0
  const yyyy = today.getFullYear(); // 获取年份
  const date = yyyy + '-' + MM + '-' + DD

  const errorMsg = {}
  // 通知结果收集
  const notifyResults = []
  let hasError = false

  try {
    // 开始签到
    for (const user of userinfo) {
      // 单账号异常隔离：任何一个账号的请求/解析出错，只记录该账号失败，
      // 不影响其余账号继续执行，也保证后续通知与 secret 刷新一定能触发。
      try {
        let headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers)
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid)
          printRed(`token过期或账号不存在, userid: ${safeUserId}`)
          errorMsg[safeUserId] = {
            msg: `token过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail)
          }
          notifyResults.push({
            nickname: safeUserId,
            status: '失败',
            listen: '账号不存在',
            vipClaim: '0/8',
            vipExpiry: '未知',
            error: 'token过期或账号不存在'
          })
          hasError = true
          continue
        }
        const safeNickname = maskDisplayName(userDetail.data.nickname)
        printMagenta(`账号 ${safeNickname} 开始领取VIP...`)

        // 周日刷新token
        if (today.getDay() === 0) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers)
          if (refreshToken?.status == 1) {
            if (refreshToken?.data?.token !== user.token) {
              needRefresh = true
              printYellow(`账号 ${safeNickname} 需要刷新token`)
              user.token = refreshToken.data.token
              // 用新 token 重建本次请求的 headers，使后续听歌/VIP 领取使用刷新后的凭证
              headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
            }
          }
        }

        // 开始听歌
        printYellow(`开始听歌领取VIP...`)
        // 听歌获取vip
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers)

        let listenStatus = '未知'
        if (listen.status === 1) {
          printGreen("听歌领取成功")
          listenStatus = '成功'
        } else if (listen.error_code === 130012) {
          printGreen("今日已领取")
          listenStatus = '今日已领取'
        } else {
          errorMsg[`${safeNickname} listen`] = summarizeResponse(listen)
          printRed("听歌领取失败")
          listenStatus = '失败'
          hasError = true
        }

        printYellow("开始领取VIP...")
        let claimCount = 0
        let claimTotal = 0
        for (let i = 1; i <= 8; i++) {
          // ad获取vip
          const r = await claimVip(headers)
          claimTotal = i
          if (r.ok) {
            printGreen(`第${i}次领取成功`)
            claimCount++
            if (i != 8) {
              await delay(30 * 1000)
            }
          } else if (r.exhausted) {
            printGreen("今天次数已用光")
            break
          } else {
            // 重试后仍然失败，视为该账号本轮领取异常，中断本账号但不再让整个任务失败
            printRed(`第${i}次领取失败（已重试）`)
            errorMsg[`${safeNickname} ad`] = summarizeResponse(r.resp)
            hasError = true
            break
          }
        }

        let vipExpiry = '未知'
        const vip_details = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
        if (vip_details.status === 1 && Array.isArray(vip_details.data?.busi_vip) && vip_details.data.busi_vip.length > 0) {
          vipExpiry = vip_details.data.busi_vip[0].vip_end_time
          printBlue(`今天是：${date}`)
          printBlue(`VIP到期时间：${vipExpiry}\n`)
        } else {
          printRed("获取失败\n")
          errorMsg[`${safeNickname} vip_details`] = summarizeResponse(vip_details)
          hasError = true
        }

        // 今日已领取且一次都没领到 → 说明今天早就签完了，属于正常状态
        const alreadyDone = listenStatus === '今日已领取' && claimCount === 0
        let status = '成功'
        if (listenStatus === '失败') status = '部分失败'
        else if (claimCount === 0 && !alreadyDone) status = '部分失败'

        notifyResults.push({
          nickname: safeNickname,
          status,
          listen: listenStatus,
          vipClaim: alreadyDone ? '今日已完成' : `${claimCount}/${claimTotal}`,
          vipExpiry,
          error: ''
        })
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || '未知')
        printRed(`账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`)
        errorMsg[safeUserId] = { msg: '处理异常', error: err && err.message ? err.message : String(err) }
        notifyResults.push({
          nickname: safeUserId,
          status: '失败',
          listen: '异常',
          vipClaim: '0/8',
          vipExpiry: '未知',
          error: err && err.message ? err.message : String(err)
        })
        hasError = true
        continue
      }
    }

  } finally {
    close_api(api)
  }

  // 更新secret <USERINFO>（使用完整 userinfo 数组，保留所有用户包括过期账号）
  let secretError = null
  if (needRefresh) {
    if (hasSecretWriteToken()) {
      const userinfoJSON = JSON.stringify(userinfo)
      try {
        setRepoSecret("USERINFO", userinfoJSON)
        printGreen("secret <USERINFO> token刷新成功")
      } catch (error) {
        printRed("token刷新失败")
        console.dir(sanitizeForLog({ message: error.message }), { depth: null })
        // 不再抛出：签到本身已经跑完，PAT 失效属于配置问题。
        // 让它变成红叉只会掩盖真实结果，改为写进通知里告警。
        secretError = (error && error.message ? error.message : String(error)).split('\n')[0]
      }
    } else {
      printYellow("存在账号需要刷新token，但是未配置PAT，未刷新token最多两个月后过期")
      secretError = "未配置 PAT"
    }
  }

  // 构建通知内容（放在 secret 更新之后、错误抛出之前，确保始终执行）
  const title = `酷狗签到${hasError ? '异常' : '成功'} ${date}`
  let content = `📅 日期: ${date}\n`
  content += `📊 账号数: ${notifyResults.length}\n`
  const successCount = notifyResults.filter(r => r.status === '成功').length
  const failCount = notifyResults.length - successCount
  content += `✅ 成功: ${successCount}  ❌ 失败: ${failCount}\n`

  for (const r of notifyResults) {
    content += `\n【${r.nickname}】\n`
    content += `  🎵 听歌领取: ${r.listen}\n`
    content += `  🎁 VIP领取: ${r.vipClaim}\n`
    content += `  ⏰ VIP到期: ${r.vipExpiry}\n`
    if (r.error) {
      content += `  ⚠️ 错误: ${r.error}\n`
    }
  }

  if (secretError) {
    content += `\n🔧 配置告警: token 刷新后未能写回 Secret\n`
    content += `  原因: ${secretError}\n`
    content += `  → 请更新仓库 Secret「PAT」（需 Secrets 读写权限）后重新运行\n`
  }

  // 发送通知（确保即使 secret 更新失败也能发出）
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  if (Object.keys(errorMsg).length > 0) {
    printRed("异常信息如下:")
    console.dir(sanitizeForLog(errorMsg), { depth: null })
  }

  // 只有「所有账号都没领到任何东西」才算整体失败。
  // 单个账号偶发 30000、或某天已签过，都不应该把 job 染红。
  const anySuccess = notifyResults.some(r => r.status === '成功')
  if (!anySuccess) {
    throw new Error("所有账号均未领取成功")
  }

  if (secretError) {
    printYellow(`注意：PAT 失效导致 token 未能写回 Secret（${secretError}），请尽快更新 PAT`)
  }

}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
