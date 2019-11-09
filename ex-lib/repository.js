import path from 'path'
import inquirer from 'inquirer'
import _ from 'lodash'
import shell from 'shelljs'
import open from 'open'

import Communication from './communication'
import Helpers from './helpers'
import Authentication from './authentication'
import Template from './template'
import configuration from './config'

const isWin = /^win/.test(process.platform)

function queryCreateRepositoryWithCookie(
  base,
  domain,
  cookies,
  customTypes,
  signedDocuments,
  users
) {
  const url = `${base}/authentication/newrepository`
  const data = {
    domain,
    plan: 'personal',
    isAnnual: 'false'
  }
  if (customTypes) data['custom-types'] = JSON.stringify(customTypes)
  if (signedDocuments) {
    data.signature = signedDocuments.signature
    data.documents = JSON.stringify(signedDocuments.docs)
  }
  if (users) data.users = users
  return Communication.post(url, data, cookies)
}

function queryCreateRepositoryWithToken(
  base,
  domain,
  token,
  customTypes,
  signedDocuments,
  users
) {
  const matches = base.match(/(https?:\/\/)(.*)/)
  const protocol = matches[1]
  const plateform = matches[2]
  const url = `${protocol}api.${plateform}/management/repositories?access_token=${token}`
  const data = {
    domain,
    plan: 'personal',
    isAnnual: 'false'
  }
  if (customTypes) data['custom-types'] = JSON.stringify(customTypes)
  if (signedDocuments) {
    data.signature = signedDocuments.signature
    data.documents = JSON.stringify(signedDocuments.docs)
  }
  if (users) data.users = users
  return Communication.post(url, data)
}

async function createWithDomain(
  base,
  domain,
  args,
  customTypes,
  signedDocuments,
  users,
  noconfirm
) {
  const oauthAccessToken = args['--oauthaccesstoken']

  try {
    await (async () => {
      if (oauthAccessToken)
        return queryCreateRepositoryWithToken(
          base,
          domain,
          oauthAccessToken,
          customTypes,
          signedDocuments,
          users
        )
      const cookies = await Authentication.connect(base, args, noconfirm)
      return queryCreateRepositoryWithCookie(
        base,
        domain,
        cookies,
        customTypes,
        signedDocuments,
        users
      )
    })()

    Helpers.UI.display(
      `You can access your backend here: ${await Helpers.MagicLink.buildRedirectUrl(
        base,
        domain
      )}`
    )
    const magicUrl = await Helpers.MagicLink.buildRedirectUrl(base, domain)
    Helpers.UI.display(
      `Redirecting you to: ${await Helpers.MagicLink.buildRedirectUrl(
        base,
        domain
      )} ...`
    )
    open(magicUrl, { wait: true })
    return domain
  } catch (error) {
    if (error.statusCode === 401) {
      // remove cookie
      return configuration
        .set({ cookies: '' })
        .then(() =>
          createWithDomain(
            base,
            domain,
            args,
            customTypes,
            signedDocuments,
            users,
            noconfirm
          )
        )
    }
    return Helpers.UI.displayErrors('An unexpected error occured')
  }
}

function promptTemplate(templates, templateName) {
  const displayTemplates = Template.getDisplayed(templates)
  return inquirer.prompt([
    {
      type: 'list',
      name: 'template',
      message: 'Technology for your project: ',
      default: _(displayTemplates).findIndex(
        tmpl => tmpl.name === templateName
      ),
      choices: _.map(displayTemplates, template => ({
        name: template.name,
        value: template
      }))
    }
  ])
}

async function chooseTemplate(domain, templates, args, noconfirm) {
  async function prompt(template) {
    const answers = await promptTemplate(templates, template)
    return answers.template
  }

  const template = args['--template']
  if (template) {
    const temp = Template.get(templates, template)
    if (!temp) {
      Helpers.UI.display(`Error: invalid template ${template}`)
      if (!noconfirm) return prompt()
    } else {
      return temp
    }
  } else {
    return prompt()
  }

  return null
}

function readCustomTypes(folder) {
  if (folder) {
    const customTypesFolder = path.join(folder, 'custom_types')
    const customTypesPath = path.join(customTypesFolder, 'index.json')
    if (shell.test('-e', customTypesPath)) {
      const customTypes = JSON.parse(shell.cat(customTypesPath))
      customTypes.forEach(t => {
        const customType = t
        const valuePath = path.join(customTypesFolder, customType.value)
        customType.value = JSON.parse(shell.cat(valuePath))
      })
      return customTypes
    }
  }
  return null
}

function readDocuments(folder) {
  const docNameFromFilename = filename => {
    const matched = filename.match(/(.*)\.json/)
    if (!matched) throw new Error(`Invalid document filename ${filename}`)
    else return matched[1]
  }

  if (folder) {
    const docsFolder = path.join(folder, 'documents')
    const metaPath = path.join(docsFolder, 'index.json')
    if (shell.test('-e', metaPath)) {
      const { signature } = JSON.parse(shell.cat(metaPath))
      if (!signature)
        throw new Error('Missing signature in your prismic documents dump.')
      const langIds = shell.ls(docsFolder).filter(p => !p.match('index.json'))

      const docs = langIds.reduce((docByLangAcc, langId) => {
        const langPath = path.join(docsFolder, langId)
        const docsFilename = shell.ls(langPath)
        const docsForLang = docsFilename.reduce((docAcc, docFilename) => {
          const docName = docNameFromFilename(docFilename)
          const docValue = JSON.parse(
            shell.cat(path.join(langPath, docFilename))
          )

          return Object.assign({}, docAcc, { [docName]: docValue })
        }, {})

        return Object.assign({}, docByLangAcc, docsForLang)
      }, {})

      return { signature, docs }
    }
  }
  return null
}

async function readZipAndCreateRepoWithCustomTypes(
  newRepository,
  base,
  domain,
  args,
  template,
  folder,
  theme,
  noconfirm
) {
  const tmpfolder = theme
    ? theme.tmpFolder
    : await Template.unzip(template.url, template.innerFolder)
  const initTemplate = () => {
    Helpers.UI.display('Initialize local project')
    // use cp instead of mv, as it would fail if tmp_dir is mounted
    // on a different device from the plugin_dir
    // fix from cordova to prevent : EXDEV: cross-device link not permitted
    shell.cp('-R', tmpfolder, folder)
    // the tmp_dir is cleaned after copy
    shell.rm('-Rf', tmpfolder)

    if (template.configuration) {
      Template.replace(folder, template, [
        {
          pattern: /your-repo-name/,
          value: domain
        }
      ])
    }
  }
  // Create repository if needed
  if (newRepository) {
    const customTypes = readCustomTypes(tmpfolder)
    const signedDocs = readDocuments(tmpfolder)
    const users = args['--users']
    await createWithDomain(
      base,
      domain,
      args,
      customTypes,
      signedDocs,
      users,
      noconfirm
    )
  }
  initTemplate()
  return null
}

function installAndDisplayInstructions(template, folder) {
  if (folder) {
    Helpers.UI.display('Running npm install...')
    const devnull = isWin ? 'NUL' : '/dev/null'
    shell.cd(folder)
    shell.exec(`npm install > ${devnull}`)
    Helpers.UI.display('Your project is ready, to proceed:\n')
    Helpers.UI.display(`Go to the project folder : cd ${folder}`)
    if (template.instructions) {
      Helpers.UI.display(template.instructions)
    }
  }
  return template
}

async function create(templates, base, domain, args, theme) {
  const noconfirm = args['--noconfirm'] === true
  const newRepository = args['--new'] === true

  const d = await chooseDomain(newRepository, base, domain, args, noconfirm)
  const folder = await chooseFolder(d, args, noconfirm)
  const template = theme
    ? theme.template
    : await chooseTemplate(d, templates, args, noconfirm)
  await readZipAndCreateRepoWithCustomTypes(
    newRepository,
    base,
    d,
    args,
    template,
    folder,
    theme,
    noconfirm
  )
  installAndDisplayInstructions(template, folder)
}

function isGithubRepository(value) {
  const matchesGit = value.match(
    /^(https?:\/\/github\.com\/[\w-.]+\/[\w-.]+)\.git$/
  )
  const url = (matchesGit && matchesGit[1]) || value
  const matches = url.match(
    /^(https?:\/\/github\.com\/[\w-.]+\/([\w-.]+))(\/tree\/([\w-./+]+))?$/
  )

  if (matches) {
    const branchName = matches[4] || 'master'
    const zipUrl = `${matches[1]}/archive/${branchName}.zip`
    const repoName = matches[2]
    const innerFolder = `${repoName}-${branchName.replace(/\/|\+/g, '-')}`

    return {
      url: zipUrl,
      name: repoName,
      innerFolder
    }
  }

  return null
}

function isGithubZip(url) {
  const regexp = new RegExp(
    '^https://github\\.com/[\\w\\-\\.]+/([\\w\\-\\.]+)(/([\\w\\-\\.]+))+/([\\w\\-\\.]+).zip$'
  )
  const matches = url.match(regexp)
  if (matches) {
    const innerFolder = `${matches[1]}-${matches[4]}`
    return { url, name: matches[1], innerFolder }
  }
  return null
}

function isZipURL(url) {
  const regexp = /^https?:\/\/(.*?)\/.*\.zip$/
  const matches = url.match(regexp)
  if (matches) {
    return { url, name: matches[1], innerFolder: null }
  }
  return null
}

function isValidThemeURL(themeURL) {
  return (
    isGithubRepository(themeURL) || isGithubZip(themeURL) || isZipURL(themeURL)
  )
}

function promptThemeURL(themeURL) {
  return inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: 'URL of your theme (zip/github): ',
      default: themeURL,
      validate(value) {
        return !isValidThemeURL(value) ? 'Invalid URL please try again!' : true
      }
    }
  ])
}

function checkThemeConfig(themeTmpFolder, customConfigPath) {
  const configPath = customConfigPath || Helpers.Theme.defaultConfigPath
  return shell.test('-f', path.join(themeTmpFolder, configPath))
}

async function validateTheme(themeURL, opts) {
  const { ignoreConf, configPath } = opts

  async function retry(url, message) {
    if (message) Helpers.UI.display(message)
    const answers = await promptThemeURL(themeURL)
    return validateTheme(answers.url, opts)
  }

  if (!themeURL) return retry()

  try {
    Helpers.UI.display('We are checking the theme integrity')
    const themeData = isValidThemeURL(themeURL)
    if (themeData) {
      const tmpFolder = await Template.unzip(
        themeData.url,
        themeData.innerFolder
      )
      const isValidConfig =
        ignoreConf || checkThemeConfig(tmpFolder, configPath)

      if (isValidConfig) {
        return Helpers.Theme.make(
          themeData.name,
          themeData.url,
          configPath,
          ignoreConf,
          tmpFolder,
          themeData.innerFolder
        )
      }
      return retry(themeURL, 'Invalid theme provided, check your zip file.')
    }
    return retry(themeURL, 'Invalid theme provided, check your zip file.')
  } catch (exception) {
    return retry(themeURL, 'Invalid theme provided, check your zip file.')
  }
}

async function heroku(templates, templateName) {
  const template = Template.get(templates, templateName)
  Helpers.UI.display('Initialize heroku project')

  let answers
  if (template) {
    answers = { template: Template.get(templates, templateName) }
  } else {
    answers = await promptTemplate(templateName)
  }

  if (!answers.template.url) {
    throw new Error('Not implemented yet!')
  }
  Helpers.UI.display('Initialize local project...')
  await Template.unzip(answers.template.url, answers.template.innerFolder)
  Template.replace('.', answers.template, [
    {
      pattern: /['"]https:\/\/your-repo-name(\.cdn)?\.prismic\.io\/api['"]/,
      value: 'process.env.PRISMIC_ENDPOINT'
    }
  ])
  Helpers.UI.display('Running npm install...')
  shell.exec(`npm install > ${isWin ? 'NUL' : '/dev/null'}`)
  Helpers.UI.display([
    'Your project in ready! Next steps:',
    " => Open your writing room: 'heroku addons:docs prismic'",
    " => Create the custom types as described in the docs: 'heroku addons:docs prismic'",
    " => Run the project: 'heroku local'"
  ])
}

export default {
  create,
  validateTheme,
  readCustomTypes,
  heroku,
  chooseDomain,
  createWithDomain
}
