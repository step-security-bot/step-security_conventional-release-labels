const core = require('@actions/core')
const github = require('@actions/github')
const fs = require('fs')
const { readFile } = fs.promises
const { parser } = require('@conventional-commits/parser')
const axios = require('axios')

async function validateSubscription () {
  let repoPrivate
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (eventPath && fs.existsSync(eventPath)) {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = payload?.repository?.private
  }

  const upstream = 'bcoe/conventional-release-labels'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'
  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')
  if (repoPrivate === false) return
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body = { action: action || '' }
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body, { timeout: 3000 }
    )
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error('\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m')
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`)
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

const api = module.exports = {
  addLabels,
  isPullRequest,
  main,
  removeLabel
}

async function main () {
  await validateSubscription()
  const { visit } = await import('unist-util-visit')
  const labelMap = JSON.parse(core.getInput('type_labels'))
  const ignoreLabel = core.getInput('ignore_label')
  const ignoredTypes = JSON.parse(core.getInput('ignored_types'))
  if (!process.env.GITHUB_EVENT_PATH) {
    console.warn('no event payload found')
    return
  }
  const payload = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')
  )
  if (!api.isPullRequest(payload)) {
    console.info('skipping non pull_request')
  }
  let titleAst
  try {
    titleAst = parser(payload.pull_request.title)
  } catch (err) {
    console.warn(err.message)
    return
  }
  const cc = {
    breaking: false
  }
  // <type>, "(", <scope>, ")", ["!"], ":", <whitespace>*, <text>
  visit(titleAst, (node) => {
    switch (node.type) {
      case 'type':
        cc.type = node.value
        break
      case 'scope':
        cc.scope = node.value
        break
      case 'breaking-change':
        cc.breaking = true
        break
      default:
        break
    }
  })

  const labels = []
  if (cc.breaking) labels.push(labelMap.breaking)
  if (labelMap[cc.type]) labels.push(labelMap[cc.type])
  if (labels.length || ignoredTypes.includes(cc.type)) {
    // Remove all configured Conventional Commit labels:
    for (const label of Object.values(labelMap)) {
      await api.removeLabel(label, payload)
    }
    // Also remove the special ignore label:
    await api.removeLabel(ignoreLabel, payload)
    // Add special ignore label to conventional commit types like "chore:":
    if (ignoredTypes.includes(cc.type)) {
      await api.addLabels([ignoreLabel], payload)
    } else {
      // Otherwise apply label associated with type:
      await api.addLabels(labels, payload)
    }
  }
}

function isPullRequest (payload) {
  return !!payload.pull_request
}

async function addLabels (labels, payload) {
  const octokit = getOctokit()
  await octokit.rest.issues.addLabels({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.pull_request.number,
    labels
  })
}

async function removeLabel (name, payload) {
  const octokit = getOctokit()
  try {
    await octokit.rest.issues.removeLabel({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.pull_request.number,
      name
    })
  } catch (err) {
    if (err.status === 404) return undefined
    else throw err
  }
}

let cachedOctokit
function getOctokit () {
  if (!cachedOctokit) {
    const token = core.getInput('token')
    const octokit = github.getOctokit(token)
    cachedOctokit = octokit
  }
  return cachedOctokit
}

main()
  .catch((err) => {
    core.setFailed(err.message)
  })
