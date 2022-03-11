const axios = require('axios')
const log = require('log').get('feishu-provider')

const {
  makeGroupEntry,
  makePersonEntry,
  makeOrganizationUnitEntry,
  addMemberToGroup,
} = require('../utilities/ldap')
const {
  saveCacheToFile,
  loadCacheFromFile,
} = require('../utilities/cache')

const apis = {
  getTenantAccessToken: async function(appKey, appSecret) {
    return await axios(`https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      data: JSON.stringify({
        "app_id": appKey,
        "app_secret": appSecret
      }),
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    })
  },
  getSingleDepartmentWithChildren: async function(id, params, headers) {
    return await axios(`https://open.feishu.cn/open-apis/contact/v3/departments/${id}/children`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        ...headers
      },
      params: params
    })
  },
  getSingleDepartment: async function(id, params, headers) {
    return await axios(`https://open.feishu.cn/open-apis/contact/v3/departments/${id}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        ...headers
      },
      params: params
    })
  },
  getUsersByDepartment: async function(department_id, params, headers) {
    return await axios(`https://open.feishu.cn/open-apis/contact/v3/users/find_by_department`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        ...headers
      },
      params: {
        ...params,
        department_id: department_id
      }
    })
  },
}

var appKey = ''
var appSecret = ''
var accessToken = ''
var tokenExpire = 0
var rootName = ""

var globalDepsMap = {}

var allLDAPUsers = []
var allLDAPOrgUnits = []
var allLDAPGroups = []
var allLDAPEntries = []

function parseName(name) {
    // 如果有空格，以英文处理，最后一个单词为姓，其他为名
    // 如果有点·，以少数民族处理，第一个部分为姓，其他为名
    // 如果都没有，前两个字先从复姓列表里面匹配，匹配不到则第一个字为姓
    const ChineseComplexSN = ["欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良", "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里", "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲", "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖", "第五", "公乘", "贯丘", "公皙", "南荣", "东里", "东宫", "仲长", "子书", "子桑", "即墨", "淳于", "达奚", "褚师", "吴铭", "纳兰", "归海"]
    let givenName = "", sn = ""
    if (name.indexOf(" ") != -1) {
      const parts = name.split(' ')
      sn = parts.pop()
      givenName = parts.join(' ')
    }
    else if (name.indexOf("·") != -1) {
      const parts = name.split("·")
      sn = parts[0]
      givenName = parts.slice(1).join("·")
    }
    else if (ChineseComplexSN.indexOf(name.slice(0, 2)) != -1) {
      sn = name.slice(0, 2)
      givenName = name.slice(2)
    }
    else {
      sn = name[0]
      givenName = name.slice(1)
    }
    
    return { givenName, sn }
}

/*
  {
    "code": 0,
    "expire": 7200,
    "msg": "ok",
    "tenant_access_token": "__TOKEN__"
  }
*/
async function getToken(key, secret) {
  appKey = key ?? appKey
  appSecret = secret ?? appSecret
  tokenExpire = tokenExpire ?? 0
  if (Date.now() - tokenExpire < 30 * 60 || !(await testToken(accessToken))) {
    const call = await apis.getTenantAccessToken(appKey, appSecret)
    const token = call.data
    if (token && token.tenant_access_token) {
      accessToken = token.tenant_access_token
      tokenExpire = Date.now() + token.expire
      return {
        accessToken: accessToken,
        tokenExpire: tokenExpire
      }
    } else {
      log.error("getToken call: ", call)
      throw "Failed to get tenant access token."
    }
  }
}

async function testToken(token) {
  try {
    const call = await apis.getSingleDepartmentWithChildren(0)
    if (call.isAxiosError) {
      return false
    }
    return true
  } catch(e) {
    return false
  }
}

/*
{
  '100560627': {
    name: 'Product & Dev / 产品技术',
    open_department_id: 100560627,
    parent_department_id: 111865024,
    dn: 'ou=Product & Dev / 产品技术, ou=全员, o=LongBridge, dc=longbridge-inc, dc=com'
  },
*/
async function fetchAllDepartments() {
  let allDeps = loadCacheFromFile('feishu_departments.json')
  if (!allDeps) {
    await getToken()
    let hasMorePages = false, pageToken = null
    let deps = []
    do {
      const call = await apis.getSingleDepartmentWithChildren(0, {
        user_id_type: "union_id",
        fetch_child: true,
        page_size: 50,
        ...(hasMorePages ? { page_token: pageToken } : {})
      })
      const body = call.data
      if (!body || body.code != 0) {
        return deps
      }
      if (body.has_more) {
        hasMorePages = true
        pageToken = body.page_token
      }
      else {
        hasMorePages = false
      }
      deps = deps.concat(deps, body.data.items)
    } while (hasMorePages)
    log.info('Got', deps.length, 'departments')

    const depsMap = {
      '0': {
        name: rootName,
        open_department_id: 0,
        parent_department_id: null,
        root: true
      },
    }

    deps = deps.filter((department) => !(department.status?.is_deleted))
    deps.forEach(d => {
      d.name = d.name.replace(/ \/ /g, ' - ').replace(/\//g, '&').trim()
      depsMap[d.open_department_id] = d
    })

    allDeps = Object.values(depsMap)
    const allDepNames = {}
    allDeps.forEach(v => {
      let name = v.name
      let idx = 2
      while (allDepNames[name]) {
        name = v.name + idx
        idx++
      }
      allDepNames[name] = 1
      v.name = name
    })

    saveCacheToFile('feishu_departments.json', allDeps)
  }
  const depsMap = {}
  allDeps.forEach(d => { depsMap[d.open_department_id] = d; })
  allDeps.forEach(d => {
    let obj = d
    let dn = [ obj.root ? obj.name : `ou=${obj.name}` ]
    while (obj.parent_department_id) {
      obj = depsMap[obj.parent_department_id]
      if (obj.root) {
        dn.push(obj.name)
      }
      else {
        dn.push(`ou=${obj.name}`)
      }
    }
    d.dn = dn.join(',')
  })
  globalDepsMap = depsMap

  return allDeps
}

/*
{
  avatar: {
    avatar_240: 'https://s1-imfile.feishucdn.com/static-resource/v1/17fbb09b-477c-4353-ad35-c285967c1fa7~?image_size=240x240&cut_type=&quality=&format=png&sticker_format=.webp',
    avatar_640: 'https://s1-imfile.feishucdn.com/static-resource/v1/17fbb09b-477c-4353-ad35-c285967c1fa7~?image_size=640x640&cut_type=&quality=&format=png&sticker_format=.webp',
    avatar_72: 'https://s1-imfile.feishucdn.com/static-resource/v1/17fbb09b-477c-4353-ad35-c285967c1fa7~?image_size=72x72&cut_type=&quality=&format=png&sticker_format=.webp',
    avatar_origin: 'https://s1-imfile.feishucdn.com/static-resource/v1/17fbb09b-477c-4353-ad35-c285967c1fa7~?image_size=noop&cut_type=&quality=&format=png&sticker_format=.webp'
  },
  city: '',
  country: '',
  department_ids: [ 'od-6fe89b719deba86e6b81016463b30955' ],
  description: '',
  email: '',
  employee_no: '',
  employee_type: 2,
  en_name: '',
  gender: 1,
  is_tenant_manager: false,
  job_title: '',
  join_time: 0,
  mobile: '+8613800138000',
  mobile_visible: true,
  name: 'demoUser1',
  open_id: 'ou_a570684d6348267e05b4839cd466d5c6',
  orders: [
    {
      department_id: 'od-6fe89b719deba86e6b81016463b30955',
      department_order: 1,
      user_order: 0
    }
  ],
  status: {
    is_activated: true,
    is_exited: false,
    is_frozen: false,
    is_resigned: false,
    is_unjoin: false
  },
  union_id: 'on_4efa47a76aca687a09e679fce7921a8f',
  user_id: 'deadbeef',
  work_station: '',
}
*/
async function fetchDepartmentUsers(department) {
  log.info(`get users for department ${department.dn}`)
  await getToken()
  const userlist = []
  let hasMorePages = false
  let pageToken = null

  do {
    const call = await apis.getUsersByDepartment(department.open_department_id, {
      user_id_type: "union_id",
      page_size: 50,
      ...(hasMorePages ? { page_token: pageToken } : {})
    })
    const body = call.data
    if (body.data.has_more) {
      hasMorePages = true
      pageToken = body.data.page_token
    }
    else {
      hasMorePages = false
    }
    if (body.data.items)
      userlist.push(...body.data.items)
  } while (hasMorePages)

  log.info(`got ${userlist.length} users for department ${department.dn}`)
  console.error(`got ${userlist.length} users for department ${department.dn}`)
  return userlist
}

async function fetchAllUsers(departments) {
  let allUsers = loadCacheFromFile('feishu_users.json')
  if (!allUsers && departments?.length > 0) {
    await getToken()
    allUsers = []
    for (let i = 0; i < departments.length; ++i) {
      allUsers.push(...(await fetchDepartmentUsers(departments[i])))
    }
    //allUsers = allUsers.filter(u => {return (u.enterprise_email || u.email)})
    saveCacheToFile('feishu_users.json',  allUsers)
  }

  return allUsers
}

async function setupProvider(config) {
  appKey = config.appKey
  appSecret = config.appSecret
  rootName = config.rootName ?? "ou=feishu"
  await reloadFromFeishuServer()
}

async function reloadFromFeishuServer() {
  await getToken()

  // 获取所有部门
  let allDepartments = await fetchAllDepartments()

  // 映射到 organizationalUnit
  const allDepartmentsMap = {}
  allLDAPOrgUnits = allDepartments.map(d => {
    allDepartmentsMap[d.open_department_id] = d
    return makeOrganizationUnitEntry(d.dn, d.name, {
      groupid: d.open_department_id,
    })
  })

  // 映射到 groupOfNames
  const allLDAPGroupsMap = []
  allLDAPGroups = allDepartments.map(d => {
    const g = makeGroupEntry(d.dn, d.name, [], {
      groupid: d.open_department_id,
    })
    allLDAPGroupsMap[d.open_department_id] = g
    return g
  })

  Object.values(allDepartmentsMap).forEach(dep => {
    if (dep.parent_department_id) {
      const parentDep = allDepartmentsMap[dep.parent_department_id]
      addMemberToGroup(allLDAPGroupsMap[dep.open_department_id], allLDAPGroupsMap[parentDep.open_department_id])
    }
  })

  // 按部门获取所有员工
  const allUsers = await fetchAllUsers(allDepartments)

  
  const allUsersMap = {}
  allLDAPUsers = allUsers.filter(u => {
    if (!allUsersMap[u.user_id]) {
      allUsersMap[u.user_id] = 1
      return u.status.is_activated && !(u.status.is_exited || u.status.is_frozen || u.status.is_resigned || u.status.is_unjoin)
    }
    return false
  }).filter(u => {
    if (!(u.enterprise_email || u.email)) {
      log.warn('Incorrect user missing email', u)
      return false
    }
    return true
  }).map(u => {
    const mail = (u.enterprise_email || u.email).toLowerCase()
    const firstDepartment = globalDepsMap[u.orders[0].department_id]

    const { givenName, sn } = parseName(u.name)
    const sAMAccountName = (u.enterprise_email && u.enterprise_email.toString().indexOf("@") != 1 
                         && u.enterprise_email.split("@")[0]) || mail
    const dn = `sAMAccountName=${sAMAccountName},${firstDepartment.dn}`

    // 映射到 iNetOrgPerson
    const personEntry = makePersonEntry(dn, {
      uid: u.user_id,
      title: u.job_title,
      mobileTelephoneNumber: u.mobile,
      sAMAccountName,
      cn: u.name,
      givenName,
      sn,
      mail,
      avatarurl: u.avatar.avatar_origin,
      openId: u.open_id,
      unionId: u.union_id,
      remark: u.description
    })

    // 将用户加到组里
    u.department_ids.forEach(depId => {
      let parentDep = allDepartmentsMap[depId]
      // allLDAPGroupsMap[parentDep.open_department_id].attributes.member.push(personEntry.dn)
      while (parentDep && parentDep.open_department_id) {
        addMemberToGroup(personEntry, allLDAPGroupsMap[parentDep.open_department_id])
        // console.log('add member', personEntry.attributes.cn, 'to', allLDAPGroupsMap[parentDep.open_department_id].attributes.cn)
        parentDep = allDepartmentsMap[parentDep.parent_department_id]
      }
    })

    return personEntry
  })

  allLDAPEntries = [].concat(allLDAPGroups, allLDAPOrgUnits, allLDAPUsers)
}

function getAllLDAPEntries() {
  return allLDAPEntries
}

function reloadEntriesFromProvider() {
  log.info('Reload entries from Feishu')
  reloadFromFeishuServer()
}


// if (0) {
//   (async function() {
//     await setupProvider(require('../config').provider)
//     log.info(getAllLDAPEntries())
//   })()
//   setTimeout(() => {}, 0)
// }

module.exports = {
  setupProvider,
  getAllLDAPEntries,
  reloadEntriesFromProvider,
}
